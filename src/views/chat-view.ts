// 对话面板 -- 主编辑区 View，全宽聊天界面 + Markdown 渲染

import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Component, TFile, setIcon, requestUrl } from "obsidian";
import { callLLMStreamWithFallback } from "../core/llm";
import { describeLLMFailure } from "../core/llm-user-message";
import { sanitizeLLMOutput } from "../core/sanitize";
import { readWikiFiles, filesToMap, vectorSearch, buildEmbeddingCache, ensureFolder } from "../core/file-utils";
import type { SecondBrainPlugin } from "../types";
import { openPluginSettings } from "../types";
import { t, LANG_INSTRUCTION } from "../core/i18n";
import { findWikiFile } from "./wiki-shared";
import { quickIngest } from "../core/quick-ingest";
import { RAW_FLASH_INBOX } from "../core/raw-organize";

export const VIEW_TYPE_CHAT = "second-brain-chat";

export class ChatView extends ItemView {
	plugin: SecondBrainPlugin;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private chatHistory: Array<{ role: string; content: string }> = [];
	private wikiMap: Record<string, string> = {};
	private sending = false;
	private saving = false;
	private abortController: AbortController | null = null;
	private component: Component;
	private contextIndicator!: HTMLElement;
	private streamRenderPending = false;
	private streamRenderRaf = 0;

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.component = new Component();
	}

	getViewType() { return VIEW_TYPE_CHAT; }
	getDisplayText() { return t("chat.title", this.plugin.settings.language); }
	getIcon() { return "message-circle"; }

	private static readonly STORAGE_KEY = "sb-chat-history";
	private static readonly MAX_HISTORY = 50;

	private saveHistory(): void {
		try {
			const data = this.chatHistory.slice(-ChatView.MAX_HISTORY * 2);
			this.app.saveLocalStorage(ChatView.STORAGE_KEY, JSON.stringify(data));
		} catch { /* quota exceeded, ignore */ }
	}

	private loadHistory(): Array<{ role: string; content: string }> {
		try {
			const raw = this.app.loadLocalStorage(ChatView.STORAGE_KEY);
			if (!raw || typeof raw !== "string") return [];
			const data = JSON.parse(raw);
			if (!Array.isArray(data)) return [];
			return data.slice(-ChatView.MAX_HISTORY * 2);
		} catch { return []; }
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.classList.add("second-brain-chat");
		const lang = this.plugin.settings.language;

		// 头部
		const header = container.createDiv({ cls: "sb-chat-header" });
		const titleRow = header.createDiv({ cls: "sb-chat-title-row" });
		const titleBlock = titleRow.createDiv({ cls: "sb-chat-title-block" });
		const titleIcon = titleBlock.createSpan({ cls: "sb-chat-title-icon" });
		setIcon(titleIcon, "message-circle");
		titleBlock.createSpan({ text: t("chat.title", lang), cls: "sb-chat-title" });
		const modelInfo = titleRow.createDiv({ cls: "sb-chat-pro-info" });
		modelInfo.createSpan({ text: this.plugin.settings.model, cls: "sb-chat-pro-tag" });
		const clearBtn = header.createEl("button", { text: t("chat.clear", lang), cls: "sb-chat-clear-btn", attr: { type: "button" } });
		clearBtn.addEventListener("click", () => {
			this.chatHistory = [];
				this.saveHistory();
			this.messagesEl.empty();
			this.contextIndicator.classList.add("sb-hidden");
			this.addWelcome();
		});

		// 消息区
		this.messagesEl = container.createDiv({ cls: "sb-messages", attr: { role: "log", "aria-live": "polite" } });
		this.addWelcome();

		// Replay persisted history
		const saved = this.loadHistory();
		if (saved.length > 0) {
			const welcome = this.messagesEl.querySelector(".sb-welcome");
			if (welcome) welcome.remove();
			this.chatHistory = saved;
			for (const msg of saved) {
				if (msg.role === "user") {
					this.addUserMessage(msg.content);
				} else if (msg.role === "assistant") {
					const el = this.addAiMessagePlaceholder();
					const typing = el.querySelector(".sb-typing");
					if (typing) typing.remove();
					const contentEl = el.querySelector(".sb-ai-content") as HTMLElement;
					if (contentEl) void MarkdownRenderer.render(this.app, sanitizeLLMOutput(msg.content), contentEl, "", this.component);
					this.addMsgCopyBtn(el);
				}
			}
		}

		// 上下文指示器
		this.contextIndicator = container.createDiv({ cls: "sb-context-indicator" });
		this.contextIndicator.classList.add("sb-hidden");
		this.updateContextIndicator();

		// 输入区
		const inputArea = container.createDiv({ cls: "sb-input-area" });


		const composer = inputArea.createDiv({ cls: "sb-chat-composer" });
		this.inputEl = composer.createEl("textarea", {
			attr: { placeholder: t("chat.placeholder", lang), rows: "1" },
			cls: "sb-chat-input",
		});
		const composerActions = composer.createDiv({ cls: "sb-chat-composer-actions" });
		inputArea.createDiv({ cls: "sb-chat-input-hint", text: t("chat.inputHint", lang) });
		const sendBtn = composerActions.createEl("button", { text: t("chat.send", lang), cls: "sb-send-btn mod-cta", attr: { type: "button", "aria-label": t("chat.send", lang) } });
		const stopBtn = composerActions.createEl("button", { text: t("chat.stop", lang), cls: "sb-stop-btn", attr: { type: "button", "aria-label": t("chat.stop", lang) } });
		stopBtn.classList.add("sb-hidden");
		const saveNoteBtn = composerActions.createEl("button", { cls: "sb-save-note-btn", attr: { type: "button", "aria-label": t("chat.saveAsNote", lang) } });
		setIcon(saveNoteBtn, "save");

		sendBtn.addEventListener("click", () => { void this.send(); });
		stopBtn.addEventListener("click", () => this.stop());
	saveNoteBtn.addEventListener("click", () => { void this.saveAsNote(); });
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.send();
			}
		});
		// 自动调整高度
		this.inputEl.addEventListener("input", () => {
			this.inputEl.setCssProps({ height: "auto" });
			this.inputEl.setCssProps({ height: Math.min(this.inputEl.scrollHeight, 150) + "px" });
		});

		// 内部链接点击
		this.messagesEl.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			const anchor = target.closest("a");
			if (!anchor) return;

			const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
			if (href.startsWith("http") || anchor.classList.contains("sb-source-link")) return;

			e.preventDefault();
			const wikiFolder = this.plugin.settings.wikiFolder;
			const file = findWikiFile(this.app, wikiFolder, href);
			if (file) {
				const leaf = this.app.workspace.getLeaf(true);
				void leaf.openFile(file);
				return;
			}
			new Notice(t("chat.pageNotFound", this.plugin.settings.language, { name: href }));
		});

		// 加载 wiki
		await this.loadWiki();
	}

	private updateContextIndicator() {
		const rounds = Math.floor(this.chatHistory.length / 2);
		if (rounds > 0) {
			const lang = this.plugin.settings.language;
			this.contextIndicator.empty();
			this.contextIndicator.createSpan({ text: t("chat.contextInfo", lang, { n: rounds }) });
			const clearCtxBtn = this.contextIndicator.createEl("button", { text: t("chat.clearContext", lang), cls: "sb-context-clear" });
			clearCtxBtn.addEventListener("click", () => {
				this.chatHistory = [];
				this.contextIndicator.classList.add("sb-hidden");
			});
			this.contextIndicator.classList.remove("sb-hidden");
		} else {
			this.contextIndicator.classList.add("sb-hidden");
		}
	}

	private addWelcome() {
		const lang = this.plugin.settings.language;
		const welcome = this.messagesEl.createDiv({ cls: "sb-welcome" });
		welcome.createEl("h3", { text: t("chat.welcome", lang) });
		welcome.createEl("p", { text: t("chat.welcomeDesc", lang) });
		const tips = welcome.createDiv({ cls: "sb-tips" });
		// Dynamic suggestion: pick a real wiki page name for suggestion 3
		const wikiNames = Object.keys(this.wikiMap)
			.map(p => p.split("/").pop()!.replace(".md", ""))
			.filter(n => n !== "index" && n !== "log");
		const randomName = wikiNames.length > 0 ? wikiNames[Math.floor(Math.random() * wikiNames.length)] : "a concept";
		const examples = [t("chat.suggestion1", lang), t("chat.suggestion2", lang), t("chat.suggestion3", lang, { name: randomName })];
		for (const ex of examples) {
			const chip = tips.createDiv({ cls: "sb-tip-chip", text: ex });
			chip.addEventListener("click", () => {
				this.inputEl.value = ex;
				void this.send();
			});
		}
		// Imp 3: conditional guidance buttons
		const actionRow = welcome.createDiv({ cls: "sb-empty-btn-row" });
		if (!this.plugin.settings.apiKey) {
			const apiKeyBtn = actionRow.createEl("button", { text: t("empty.openSettings", lang), cls: "sb-empty-btn" });
			apiKeyBtn.addEventListener("click", () => {
				openPluginSettings(this.app);
			});
		}
		if (Object.keys(this.wikiMap).length === 0) {
			const compileBtn = actionRow.createEl("button", { text: t("empty.startCompile", lang), cls: "sb-empty-btn mod-cta" });
			compileBtn.addEventListener("click", () => {
				void this.plugin.activateView("second-brain-compile");
			});
		}
	}

	private async loadWiki() {
		const { wikiFolder } = this.plugin.settings;
		const files = await readWikiFiles(this.app, wikiFolder);
		this.wikiMap = filesToMap(files);
		// 构建向量缓存（后台静默执行）
		if (this.plugin.settings.embeddingApiKey || this.plugin.settings.apiKey) {
			buildEmbeddingCache(this.wikiMap, this.plugin.settings).catch(() => {});
		}
	}

	private async send() {
		if (this.sending) return;
		const q = this.inputEl.value.trim();
		if (!q) return;
		const settings = this.plugin.settings;
		const lang = settings.language;
		if (!settings.apiKey) { new Notice(t("chat.noApiKey", lang)); return; }


		this.inputEl.value = "";
		this.inputEl.setCssProps({ height: "auto" });
		this.sending = true;
		this.abortController = new AbortController();
		this.toggleButtons(true);

		// 移除 welcome
		const welcome = this.messagesEl.querySelector(".sb-welcome");
		if (welcome) welcome.remove();

		this.addUserMessage(q);

		// 搜索相关页面
		const pages = await vectorSearch(q, this.wikiMap, this.plugin.settings, 5);
		const langInstr = LANG_INSTRUCTION[lang] || LANG_INSTRUCTION["en"];
		let systemPrompt: string;
		if (pages.length > 0) {
			const context = pages.map(p => `=== ${p.filePath} ===\n${p.content.slice(0, 2000)}`).join("\n\n");
			systemPrompt = t("chat.systemPrompt", lang, { lang: langInstr, context });
		} else {
			systemPrompt = t("chat.systemPromptEmpty", lang, { lang: langInstr });
		}

		const messages = [
			{ role: "system", content: systemPrompt },
			...this.chatHistory.slice(-20),
			{ role: "user", content: q },
		];

		const aiMsgEl = this.addAiMessagePlaceholder();

		try {
			let fullText = "";
			const msgContentEl = aiMsgEl.querySelector(".sb-ai-content") as HTMLElement;

			await callLLMStreamWithFallback(messages, settings, (chunk) => {
				fullText += chunk;
				// 收到第一个 chunk 时移除 typing 指示器
				const typing = aiMsgEl.querySelector(".sb-typing");
				if (typing) typing.remove();
				// 用 rAF 合并渲染，避免每个 chunk 都触发 DOM 重排
				if (!this.streamRenderPending) {
					this.streamRenderPending = true;
					this.streamRenderRaf = requestAnimationFrame(() => {
						this.streamRenderPending = false;
						msgContentEl.empty();
						void MarkdownRenderer.render(this.app, fullText, msgContentEl, "", this.component);
						this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
					});
				}
			}, { signal: this.abortController?.signal });

			this.chatHistory.push({ role: "user", content: q });
			this.chatHistory.push({ role: "assistant", content: fullText });
				this.saveHistory();

			// 更新上下文指示器
			this.updateContextIndicator();

			// 最终渲染（净化后确保安全）
			const safeFullText = sanitizeLLMOutput(fullText);
			msgContentEl.empty();
			void MarkdownRenderer.render(this.app, safeFullText, msgContentEl, "", this.component);

			if (pages.length > 0) {
				const srcEl = msgContentEl.createDiv({ cls: "sb-sources" });
				srcEl.createSpan({ text: t("chat.refLabel", lang) });
				for (const p of pages) {
					const link = srcEl.createEl("a", { text: p.filePath, cls: "sb-source-link" });
					link.addEventListener("click", (e) => {
						e.preventDefault();
						const fullPath = this.plugin.settings.wikiFolder + "/" + p.filePath;
						const file = this.app.vault.getAbstractFileByPath(fullPath);
						if (file instanceof TFile) {
							const leaf = this.app.workspace.getLeaf(true);
							void leaf.openFile(file);
						} else {
							new Notice(t("chat.fileNotFound", lang, { name: fullPath }));
						}
					});
				}
			}

			// 为代码块添加复制按钮
			this.addInteractiveElements(msgContentEl);
		} catch (e: unknown) {
				const typing = aiMsgEl.querySelector(".sb-typing");
				if (typing) typing.remove();
				if (e instanceof DOMException && e.name === "AbortError") {
					const el = aiMsgEl.querySelector(".sb-ai-content") as HTMLElement;
					el.empty();
					void MarkdownRenderer.render(this.app, t("chat.stopped", lang), el, "", this.component);
				} else {
				const msgContentEl = aiMsgEl.querySelector(".sb-ai-content") as HTMLElement;
				msgContentEl.empty();
				msgContentEl.createEl("p", { text: t("chat.error", lang, { msg: describeLLMFailure(lang, e) }), cls: "sb-error" });
				}
		} finally {
			if (this.streamRenderRaf) cancelAnimationFrame(this.streamRenderRaf);
			this.streamRenderPending = false;
			this.sending = false;
			this.abortController = null;
			this.toggleButtons(false);
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	private addUserMessage(text: string) {
		const msgEl = this.messagesEl.createDiv({ cls: "sb-msg sb-msg-user" });
		const bubble = msgEl.createDiv({ cls: "sb-bubble sb-bubble-user" });
		bubble.textContent = text;
		const av = msgEl.createDiv({ cls: "sb-avatar sb-avatar-user" });
		setIcon(av, "user");
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private addAiMessagePlaceholder(): HTMLElement {
		const msgEl = this.messagesEl.createDiv({ cls: "sb-msg sb-msg-ai" });
		const av = msgEl.createDiv({ cls: "sb-avatar sb-avatar-ai" });
		setIcon(av, "book-open");
		const bubble = msgEl.createDiv({ cls: "sb-bubble" });
		bubble.createDiv({ cls: "sb-ai-content", text: "" });
		// 加载指示器
		const typing = bubble.createDiv({ cls: "sb-typing" });
		for (let _i = 0; _i < 3; _i++) typing.createDiv({ cls: "sb-typing-dot" });
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		return msgEl;
	}

	private addInteractiveElements(container: HTMLElement) {
		const lang = this.plugin.settings.language;

		// 代码块：复制按钮
		container.querySelectorAll("pre > code").forEach((codeEl) => {
			const pre = codeEl.parentElement;
			if (!pre || pre.querySelector(".sb-copy-btn")) return;
			const btn = createEl("button", { cls: "sb-copy-btn", text: t("chat.copy", lang) });
			btn.addEventListener("click", () => {
				void (async () => {
				await navigator.clipboard.writeText((codeEl as HTMLElement).textContent || "");
				btn.textContent = t("chat.copied", lang);
				window.setTimeout(() => { btn.textContent = t("chat.copy", lang); }, 1500);
				})();
			});
			pre.classList.add("sb-position-relative");
			pre.appendChild(btn);
		});

			// 图片：默认链接，hover 预览 + 下载
			container.querySelectorAll("img").forEach((img) => {
				if (img.closest(".sb-img-link")) return;
				const src = img.src || "";
				const name = src.split("/").pop()?.split("?")[0] || "image";
				const alt = img.alt || name;

				const link = createDiv({ cls: "sb-img-link" });
				const linkText = link.createEl("a", { text: t("chat.imageAlt", lang, { alt }), cls: "sb-img-link-text" });
				img.parentElement?.replaceChild(link, img);

				const preview = link.createDiv({ cls: "sb-img-preview" });
				const actions = preview.createDiv({ cls: "sb-img-preview-actions" });
				const dlBtn = actions.createEl("button", { text: t("chat.download", lang), cls: "sb-img-preview-btn" });
				const openBtn = actions.createEl("button", { text: t("chat.fullscreen", lang), cls: "sb-img-preview-btn" });

				let hoverTimer: number | null = null;

				const showPreview = () => { preview.classList.add("active"); };
				const hidePreview = () => { preview.classList.remove("active"); };

				linkText.addEventListener("mouseenter", () => {
					hoverTimer = window.setTimeout(showPreview, 200);
				});
				link.addEventListener("mouseleave", () => {
					if (hoverTimer) window.clearTimeout(hoverTimer);
					hidePreview();
				});
				preview.addEventListener("mouseenter", () => {
					if (hoverTimer) window.clearTimeout(hoverTimer);
				});

				dlBtn.addEventListener("click", (e) => {
					void (async () => {
					e.stopPropagation();
					try {
						if (src.startsWith("data:")) {
							const a = createEl("a", { attr: { href: src, download: "image.png" } });
							a.click();
						} else {
							const res = await requestUrl({ url: src });
							const blob = new Blob([res.arrayBuffer]);
							const url = URL.createObjectURL(blob);
							const a = createEl("a", { attr: { href: url, download: name } });
							a.click();
							URL.revokeObjectURL(url);
						}
					} catch (e) { console.warn("chat-view:", e) }
					})();
				});

				openBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					const overlay = createDiv({ cls: "sb-img-overlay" });
					overlay.createEl("img", { attr: { src } });
					overlay.addEventListener("click", () => overlay.remove());
					activeDocument.body.appendChild(overlay);
				});
			});
		// 表格：包裹可滚动 + 复制 Markdown 按钮
		container.querySelectorAll("table").forEach((table) => {
			if (table.parentElement?.classList.contains("sb-table-wrap")) return;
			const wrap = createDiv({ cls: "sb-table-wrap" });
			table.parentElement?.replaceChild(wrap, table);
			const btn = createEl("button", { cls: "sb-table-copy-btn", text: t("chat.copyTable", lang) });
			btn.addEventListener("click", () => {
				void (async () => {
				const rows = Array.from(table.querySelectorAll("tr"));
				const md = rows.map((row) => {
					const cells = Array.from(row.querySelectorAll("th, td"));
					const cellTexts = cells.map(c => (c.textContent || "").replace("|", "\\|").trim());
					return "| " + cellTexts.join(" | ") + " |";
				});
				// 在表头后加分隔行
				if (md.length > 0) {
					const colCount = (md[0].match(/\|/g) || []).length - 1;
					const sep = "| " + Array(colCount).fill("---").join(" | ") + " |";
					md.splice(1, 0, sep);
				}
				await navigator.clipboard.writeText(md.join("\n"));
				btn.textContent = t("chat.copied", lang);
				window.setTimeout(() => { btn.textContent = t("chat.copyTable", lang); }, 1500);
				})();
			});
			wrap.appendChild(btn);
			wrap.appendChild(table);
		});
	}

	private addMsgCopyBtn(msgEl: HTMLElement): void {
		const bubble = msgEl.querySelector(".sb-bubble") as HTMLElement;
		if (!bubble) return;
		const copyBtn = bubble.createEl("button", { cls: "sb-msg-copy-btn", attr: { type: "button", "aria-label": "Copy" } });
		setIcon(copyBtn, "copy");
		copyBtn.addEventListener("click", (ev) => {
			ev.stopPropagation();
			const contentEl = bubble.querySelector(".sb-ai-content") as HTMLElement;
			const text = contentEl?.textContent || "";
				void navigator.clipboard.writeText(text).then(() => {
					copyBtn.textContent = t("chat.copied", this.plugin.settings.language);
					window.setTimeout(() => setIcon(copyBtn, "copy"), 1500);
				});
		});
	}

	private toggleButtons(generating: boolean) {
		const sendBtn = this.containerEl.querySelector(".sb-send-btn") as HTMLElement;
		const stopBtn = this.containerEl.querySelector(".sb-stop-btn") as HTMLElement;
		const saveNoteBtn = this.containerEl.querySelector(".sb-save-note-btn") as HTMLButtonElement;
		if (sendBtn) sendBtn.classList.toggle("sb-hidden", generating);
		if (stopBtn) stopBtn.classList.toggle("sb-hidden", !generating);
		if (saveNoteBtn) saveNoteBtn.disabled = generating || this.saving;
	}

	private async saveAsNote() {
		if (this.saving || this.sending) return;
		const lang = this.plugin.settings.language;

		// 取最后一条 AI 回复的原始文本
		const lastAiMsg = [...this.chatHistory].reverse().find(m => m.role === "assistant");
		const content = lastAiMsg?.content?.trim();
		if (!content) {
			new Notice(t("chat.noteEmpty", lang));
			return;
		}
		if (!this.plugin.settings.apiKey) {
			new Notice(t("chat.noApiKey", lang));
			return;
		}

		this.saving = true;
		this.toggleButtons(false);

		const now = new Date();
		const date = now.toISOString().split("T")[0];
		const time = now.toTimeString().slice(0, 8).replace(/:/g, "");
		const rawFolder = this.plugin.settings.rawFolder;
		const fileName = `${date}-${time}.md`;
		const relDir = RAW_FLASH_INBOX;
		const filePath = `${rawFolder}/${relDir}/${fileName}`;

		try {
			await ensureFolder(this.app, `${rawFolder}/${relDir}`);
			await this.app.vault.create(filePath, content);
			new Notice(t("chat.noteSaved", lang, { path: filePath }));

			new Notice(t("chat.noteCompiling", lang));
			const targetFile = { path: filePath, content };
			const result = await this.plugin.runWithCompileLock(() =>
				quickIngest(this.app, this.plugin.settings, targetFile),
			);
			new Notice(t("chat.noteCompileDone", lang, { n: result.generated.length }));

			// 刷新 wiki map
			await this.loadWiki();
		} catch (e: unknown) {
			new Notice(t("chat.noteCompileFail", lang, { msg: describeLLMFailure(lang, e) }));
		} finally {
			this.saving = false;
			this.toggleButtons(false);
		}
	}

	private stop() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		this.sending = false;
		this.toggleButtons(false);
	}

	async onClose() {
		await Promise.resolve();
		this.abortController?.abort();
		if (this.streamRenderRaf) cancelAnimationFrame(this.streamRenderRaf);
		this.streamRenderPending = false;
		this.component.unload();
	}
}

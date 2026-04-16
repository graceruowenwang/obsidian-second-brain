// 对话面板 — 主编辑区 View，全宽聊天界面 + Markdown 渲染

import { ItemView, WorkspaceLeaf, Notice, MarkdownRenderer, Component } from "obsidian";
import { callLLMStream } from "../core/llm";
import { readWikiFiles, findRelevantPages, filesToMap, vectorSearch, buildEmbeddingCache } from "../core/file-utils";
import type { SecondBrainPlugin } from "../types";
import { t, LANG_INSTRUCTION } from "../core/i18n";

export const VIEW_TYPE_CHAT = "second-brain-chat";

export class ChatView extends ItemView {
	plugin: SecondBrainPlugin;
	private messagesEl: HTMLElement;
	private inputEl: HTMLTextAreaElement;
	private chatHistory: Array<{ role: string; content: string }> = [];
	private wikiMap: Record<string, string> = {};
	private sending = false;
	private abortController: AbortController | null = null;
	private component: Component;

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.component = new Component();
	}

	getViewType() { return VIEW_TYPE_CHAT; }
	getDisplayText() { return t("chat.title", this.plugin.settings.language); }
	getIcon() { return "message-circle"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.classList.add("second-brain-chat");
		const lang = this.plugin.settings.language;

		// 头部
		const header = container.createDiv({ cls: "sb-chat-header" });
		header.createEl("span", { text: t("chat.title", lang), cls: "sb-chat-title" });
		const clearBtn = header.createEl("button", { text: t("chat.clear", lang), cls: "sb-chat-clear-btn" });
		clearBtn.addEventListener("click", () => {
			this.chatHistory = [];
			this.messagesEl.empty();
			this.addWelcome();
		});

		// 消息区
		this.messagesEl = container.createDiv({ cls: "sb-messages" });
		this.addWelcome();

		// 输入区
		const inputArea = container.createDiv({ cls: "sb-input-area" });
		this.inputEl = inputArea.createEl("textarea", {
			attr: { placeholder: t("chat.placeholder", lang), rows: "1" },
			cls: "sb-chat-input",
		});
		const sendBtn = inputArea.createEl("button", { text: t("chat.send", lang), cls: "sb-send-btn mod-cta" });
		const stopBtn = inputArea.createEl("button", { text: t("chat.stop", lang), cls: "sb-stop-btn" });
		stopBtn.style.display = "none";

		sendBtn.addEventListener("click", () => this.send());
		stopBtn.addEventListener("click", () => this.stop());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.send();
			}
		});
		// 自动调整高度
		this.inputEl.addEventListener("input", () => {
			this.inputEl.style.height = "auto";
			this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 150) + "px";
		});

	// 内部链接点击：拦截 AI 回复中的 [[wikilink]] 和 <a> 链接
				this.messagesEl.addEventListener("click", (e) => {
					const target = e.target as HTMLElement;
					const anchor = target.closest("a") as HTMLAnchorElement | null;
					if (!anchor) return;

					const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
					if (href.startsWith("http") || anchor.classList.contains("sb-source-link")) return;

					e.preventDefault();
					const wikiFolder = this.plugin.settings.wikiFolder;
					const candidates = [
						`${wikiFolder}/${href}.md`,
						`${wikiFolder}/${href}`,
						`${wikiFolder}/concepts/核心概念/${href}.md`,
						`${wikiFolder}/concepts/方法框架/${href}.md`,
						`${wikiFolder}/concepts/实践经验/${href}.md`,
						`${wikiFolder}/entities/${href}.md`,
						`${wikiFolder}/sources/${href}.md`,
					];
					for (const p of candidates) {
						const file = this.app.vault.getAbstractFileByPath(p);
						if (file) {
							const leaf = this.app.workspace.getLeaf(true);
							leaf.openFile(file as any);
							return;
						}
					}
					new Notice(t("chat.pageNotFound", this.plugin.settings.language, { name: href }));
				});

						// 加载 wiki
			await this.loadWiki();
	}

	private addWelcome() {
		const lang = this.plugin.settings.language;
		const welcome = this.messagesEl.createDiv({ cls: "sb-welcome" });
		welcome.createEl("h3", { text: t("chat.welcome", lang) });
		welcome.createEl("p", { text: t("chat.welcomeDesc", lang) });
		const tips = welcome.createDiv({ cls: "sb-tips" });
		const examples = [t("chat.suggestion1", lang), t("chat.suggestion2", lang), t("chat.suggestion3", lang)];
		for (const ex of examples) {
			const chip = tips.createDiv({ cls: "sb-tip-chip", text: ex });
			chip.addEventListener("click", () => {
				this.inputEl.value = ex;
				this.send();
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
		this.inputEl.style.height = "auto";
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

		const sources = pages.length > 0 ? pages.map(p => p.filePath).join(", ") : "";
		const aiMsgEl = this.addAiMessagePlaceholder();

		try {
			let fullText = "";
			const msgContentEl = aiMsgEl.querySelector(".sb-ai-content") as HTMLElement;

			await callLLMStream(messages, settings, (chunk) => {
				fullText += chunk;
				// 收到第一个 chunk 时移除 typing 指示器
				const typing = aiMsgEl.querySelector(".sb-typing");
				if (typing) typing.remove();
				// 实时渲染 markdown
				msgContentEl.empty();
				MarkdownRenderer.render(this.app, fullText, msgContentEl, "", this.component);
				this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
			}, { signal: this.abortController?.signal });

			this.chatHistory.push({ role: "user", content: q });
			this.chatHistory.push({ role: "assistant", content: fullText });

			// 最终渲染（确保完整）
			msgContentEl.empty();
			MarkdownRenderer.render(this.app, fullText, msgContentEl, "", this.component);

			if (pages.length > 0) {
					const srcEl = msgContentEl.createDiv({ cls: "sb-sources" });
					srcEl.createEl("span", { text: t("chat.refLabel", lang) });
					for (const p of pages) {
						const link = srcEl.createEl("a", { text: p.filePath, cls: "sb-source-link" });
						link.addEventListener("click", (e) => {
							e.preventDefault();
							const fullPath = this.plugin.settings.wikiFolder + "/" + p.filePath;
							const file = this.app.vault.getAbstractFileByPath(fullPath);
							if (file) {
								const leaf = this.app.workspace.getLeaf(true);
								leaf.openFile(file as any);
							} else {
								new Notice(t("chat.fileNotFound", lang, { name: fullPath }));
							}
						});
					}
				}

			// 为代码块添加复制按钮
			this.addInteractiveElements(msgContentEl);
		} catch (e: any) {
				const typing = aiMsgEl.querySelector(".sb-typing");
				if (typing) typing.remove();
				if (e.name === "AbortError") {
					const el = aiMsgEl.querySelector(".sb-ai-content") as HTMLElement;
					el.empty();
					MarkdownRenderer.render(this.app, t("chat.stopped", lang), el, "", this.component);
				} else {
				const msgContentEl = aiMsgEl.querySelector(".sb-ai-content") as HTMLElement;
				msgContentEl.empty();
				msgContentEl.createEl("p", { text: t("chat.error", lang, { msg: e.message }), cls: "sb-error" });
				}
		} finally {
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
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private addAiMessagePlaceholder(): HTMLElement {
		const msgEl = this.messagesEl.createDiv({ cls: "sb-msg sb-msg-ai" });
		const avatar = msgEl.createDiv({ cls: "sb-avatar sb-avatar-ai", text: "AI" });
		const bubble = msgEl.createDiv({ cls: "sb-bubble" });
		bubble.createDiv({ cls: "sb-ai-content", text: "" });
		// 加载指示器
		const typing = bubble.createDiv({ cls: "sb-typing" });
		for (let i = 0; i < 3; i++) typing.createDiv({ cls: "sb-typing-dot" });
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
			btn.addEventListener("click", async () => {
				await navigator.clipboard.writeText((codeEl as HTMLElement).textContent || "");
				btn.textContent = t("chat.copied", lang);
				setTimeout(() => { btn.textContent = t("chat.copy", lang); }, 1500);
			});
			pre.style.position = "relative";
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
				const previewImg = preview.createEl("img", { attr: { src } });
				const actions = preview.createDiv({ cls: "sb-img-preview-actions" });
				const dlBtn = actions.createEl("button", { text: t("chat.download", lang), cls: "sb-img-preview-btn" });
				const openBtn = actions.createEl("button", { text: t("chat.fullscreen", lang), cls: "sb-img-preview-btn" });

				let hoverTimer: ReturnType<typeof setTimeout> | null = null;

				const showPreview = () => { preview.classList.add("active"); };
				const hidePreview = () => { preview.classList.remove("active"); };

				linkText.addEventListener("mouseenter", () => {
					hoverTimer = setTimeout(showPreview, 200);
				});
				link.addEventListener("mouseleave", () => {
					if (hoverTimer) clearTimeout(hoverTimer);
					hidePreview();
				});
				preview.addEventListener("mouseenter", () => {
					if (hoverTimer) clearTimeout(hoverTimer);
				});

				dlBtn.addEventListener("click", async (e) => {
					e.stopPropagation();
					try {
						if (src.startsWith("data:")) {
							const a = createEl("a", { attr: { href: src, download: "image.png" } });
							a.click();
						} else {
							const res = await fetch(src);
							const blob = await res.blob();
							const url = URL.createObjectURL(blob);
							const a = createEl("a", { attr: { href: url, download: name } });
							a.click();
							URL.revokeObjectURL(url);
						}
					} catch {}
				});

				openBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					const overlay = createDiv({ cls: "sb-img-overlay" });
					overlay.createEl("img", { attr: { src } });
					overlay.addEventListener("click", () => overlay.remove());
					document.body.appendChild(overlay);
				});
			});
		// 表格：包裹可滚动 + 复制 Markdown 按钮
		container.querySelectorAll("table").forEach((table) => {
			if (table.parentElement?.classList.contains("sb-table-wrap")) return;
			const wrap = createDiv({ cls: "sb-table-wrap" });
			table.parentElement?.replaceChild(wrap, table);
			const btn = createEl("button", { cls: "sb-table-copy-btn", text: t("chat.copyTable", lang) });
			btn.addEventListener("click", async () => {
				const rows = Array.from(table.querySelectorAll("tr"));
				const md = rows.map((row, i) => {
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
				setTimeout(() => { btn.textContent = t("chat.copyTable", lang); }, 1500);
			});
			wrap.appendChild(btn);
			wrap.appendChild(table);
		});
	}

	private toggleButtons(generating: boolean) {
		const sendBtn = this.containerEl.querySelector(".sb-send-btn") as HTMLElement;
		const stopBtn = this.containerEl.querySelector(".sb-stop-btn") as HTMLElement;
		if (sendBtn) sendBtn.style.display = generating ? "none" : "";
		if (stopBtn) stopBtn.style.display = generating ? "" : "none";
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
		this.component.unload();
	}
}

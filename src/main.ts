// 第二大脑 — Obsidian 插件入口

import {
	App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab,
	Setting, TFile, TFolder, ItemView, WorkspaceLeaf,
} from "obsidian";
import { DEFAULT_SETTINGS, type PluginSettings, type SecondBrainPlugin } from "./types";
import { CompileView, VIEW_TYPE_COMPILE } from "./views/compile-view";
import { ChatView, VIEW_TYPE_CHAT } from "./views/chat-view";
import { WikiView, VIEW_TYPE_WIKI } from "./views/wiki-view";
import { runCompile } from "./core/compile";
import { readRawFiles, readWikiFiles, writeWikiFile, diffFingerprints, emptyCache, filesToMap, clearEmbeddingCache } from "./core/file-utils";
import { callLLM } from "./core/llm";
import {
	buildIncrementalAnalyzePrompt, buildConceptPrompt, buildEntityPrompt, buildSourcePrompt,
} from "./core/wiki-schema";
import { loadTemplateConfig } from "./core/templates";
import { t } from "./core/i18n";

export default class SecondBrain extends Plugin {
	settings!: PluginSettings;
	private autoCompileTimer: ReturnType<typeof setTimeout> | null = null;
	private isCompiling = false;

	async onload() {
		await this.loadSettings();
		const lang = this.settings.language;

		// 注册 View
		this.registerView(VIEW_TYPE_COMPILE, (leaf) => new CompileView(leaf, this as SecondBrainPlugin));
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this as SecondBrainPlugin));
		this.registerView(VIEW_TYPE_WIKI, (leaf) => new WikiView(leaf, this as SecondBrainPlugin));

		// 左侧栏图标
		this.addRibbonIcon("zap", t("cmd.compileWiki", lang), () => this.activateView(VIEW_TYPE_COMPILE));
		this.addRibbonIcon("message-circle", t("cmd.wikiChat", lang), () => this.activateView(VIEW_TYPE_CHAT));
		this.addRibbonIcon("globe", t("cmd.wikiPreview", lang), () => this.activateView(VIEW_TYPE_WIKI));

		// 命令：编译全部
		this.addCommand({
			id: "compile-all",
			name: t("cmd.compileAll", lang),
			callback: () => this.activateView(VIEW_TYPE_COMPILE),
		});

		// 命令：编译当前文件
		this.addCommand({
			id: "compile-current",
			name: t("cmd.compileCurrent", lang),
			editorCallback: (editor: Editor, view: MarkdownView) => this.compileCurrentFile(view),
		});

		// 命令：打开对话
		this.addCommand({
			id: "open-chat",
			name: t("cmd.openChat", lang),
			callback: () => this.activateView(VIEW_TYPE_CHAT),
		});

		// 命令：打开 Wiki 预览
		this.addCommand({
			id: "open-wiki",
			name: t("cmd.openWiki", lang),
			callback: () => this.activateView(VIEW_TYPE_WIKI),
		});

		// 设置面板
		this.addSettingTab(new SecondBrainSettingTab(this.app, this));

		// 自动编译：监听 raw/ 目录文件变化
		this.registerEvent(this.app.vault.on("create", (file) => this.onRawFileChange(file as TFile | TFolder)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.onRawFileChange(file as TFile | TFolder)));

		// 启动时自动检查是否有新素材需要编译
		if (this.settings.autoCompile && this.settings.apiKey) {
			this.startupAutoCompile();
		}

		console.log("Second Brain plugin loaded");
	}

	onunload() {
		if (this.autoCompileTimer) {
			clearTimeout(this.autoCompileTimer);
			this.autoCompileTimer = null;
		}
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_COMPILE);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_WIKI);
	}

	async loadSettings() {
		const saved = (await this.loadData()) as any || {};
		// 迁移：outputLanguage → language
		if (saved.outputLanguage && !saved.language) {
			saved.language = saved.outputLanguage;
			delete saved.outputLanguage;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- 自动编译 ---

	private isRawFile(file: TFile | TFolder): boolean {
		if (!(file instanceof TFile)) return false;
		const rawPrefix = this.settings.rawFolder + "/";
		return file.path.startsWith(rawPrefix) &&
			(file.extension === "md" || file.extension === "txt");
	}

	private onRawFileChange(file: TFile | TFolder) {
		if (!this.settings.autoCompile || !this.settings.apiKey) return;
		if (!this.isRawFile(file)) return;

		// 防抖：delay 秒内只触发一次
		if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer);
		this.autoCompileTimer = setTimeout(() => {
			this.autoCompileTimer = null;
			this.triggerAutoCompile();
		}, this.settings.autoCompileDelay * 1000);
	}

	private async startupAutoCompile() {
		try {
			const allFiles = await readRawFiles(this.app, this.settings.rawFolder);
			if (allFiles.length === 0) return;

			const cache = (await this.loadData()) as any || emptyCache();
			const { changed } = diffFingerprints(allFiles, cache);
			if (changed.length > 0) {
				new Notice(t("notice.detectNew", this.settings.language, { n: changed.length }));
				this.triggerAutoCompile();
			}
		} catch {
			// 启动时静默失败
		}
	}

	private async triggerAutoCompile() {
		if (this.isCompiling) return;
		if (!this.settings.apiKey) return;

		this.isCompiling = true;
		try {
			const result = await runCompile(this.app, this.settings, undefined, false, this);
			const total = result.conceptsCount + result.entitiesCount + result.sourcesCount;
			if (!result.reused) {
				new Notice(t("notice.autoDone", this.settings.language, { n: total }));
			}
		} catch (e: any) {
			console.error("Auto compile failed:", e.message);
		} finally {
			this.isCompiling = false;
		}
	}

	// --- 手动编译 ---

	async activateView(viewType: string) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(viewType)[0];
		if (!leaf) {
			if (viewType === VIEW_TYPE_CHAT || viewType === VIEW_TYPE_WIKI) {
				leaf = workspace.getLeaf(true);
				await leaf.setViewState({ type: viewType, active: true });
			} else {
				const rightLeaf = workspace.getRightLeaf(false);
				if (rightLeaf) {
					await rightLeaf.setViewState({ type: viewType, active: true });
					leaf = rightLeaf;
				}
			}
		}
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async compileCurrentFile(view: MarkdownView) {
		const file = view.file;
		if (!file) return;

		if (!this.settings.apiKey) {
			new Notice(t("notice.noApiKey", this.settings.language));
			return;
		}

		const content = await this.app.vault.read(file);
		const targetFile = { path: file.path, content };

		new Notice(t("notice.compiling", this.settings.language, { path: file.path }));

		try {
			const wikiFiles = await readWikiFiles(this.app, this.settings.wikiFolder);
			const wikiMap: Record<string, string> = {};
			for (const f of wikiFiles) wikiMap[f.path] = f.content;

			const result = await this.quickIngest(targetFile);
			new Notice(t("notice.compileDone", this.settings.language, { n: result.generated.length }));
		} catch (e: any) {
			new Notice(t("notice.compileFail", this.settings.language, { msg: e.message }));
		}
	}

	private async quickIngest(targetFile: { path: string; content: string }) {
		const allFiles = await readRawFiles(this.app, this.settings.rawFolder);
		const wikiFiles = await readWikiFiles(this.app, this.settings.wikiFolder);
		const existingNames = Object.keys(filesToMap(wikiFiles)).map(p => p.split("/").pop()!.replace(/\.md$/, ""));

		const tpl = await loadTemplateConfig(this.app, this.settings.templateFile, this.settings.language);

		const changedMaterials = `--- 文件: ${targetFile.path} ---\n${targetFile.content.slice(0, 4000)}`;
		const prompt = buildIncrementalAnalyzePrompt(changedMaterials, existingNames, tpl);

		const analysisResult = await callLLM(
			[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: prompt }],
			this.settings,
			{ maxTokens: 4000 }
		);

		const jsonMatch = analysisResult.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim().match(/\{[\s\S]*\}/);
		if (!jsonMatch) throw new Error("分析结果格式异常");
		const analysis = JSON.parse(jsonMatch[0]);

		const concepts = analysis.concepts || [];
		const generated: string[] = [];
		const errors: Array<{ name: string; error: string }> = [];

		const tasks: Array<{ name: string; path: string; type: string; item: any; materials: string }> = [];
		for (const c of concepts) {
			const levelDir = c.level === "核心概念" ? "核心概念" : c.level === "实践经验" ? "实践经验" : "方法框架";
			const pagePath = `concepts/${levelDir}/${c.name}.md`;
			tasks.push({ name: c.title || c.name, path: pagePath, type: "concept", item: c, materials: targetFile.content.slice(0, 10000) });
		}
		for (const e of (analysis.entities || [])) {
			tasks.push({ name: e.name, path: `entities/${e.name}.md`, type: "entity", item: e, materials: targetFile.content.slice(0, 8000) });
		}
		for (const s of (analysis.sources || [])) {
			tasks.push({ name: s.name, path: `sources/${s.name}.md`, type: "source", item: s, materials: targetFile.content.slice(0, 10000) });
		}

		for (const task of tasks) {
			let genPrompt: string;
			let system: string;
			if (task.type === "concept") { genPrompt = buildConceptPrompt(task.item, task.materials, concepts, tpl); system = tpl.editorSystemPrompt; }
			else if (task.type === "entity") { genPrompt = buildEntityPrompt(task.item, task.materials, concepts, tpl); system = tpl.editorSystemPrompt; }
			else { genPrompt = buildSourcePrompt(task.item, task.materials, concepts, tpl); system = tpl.editorSystemPrompt; }

			try {
				const raw = await callLLM([{ role: "system", content: system }, { role: "user", content: genPrompt }], this.settings, { temperature: 0.3 });
				let page = raw;
				const fmMatch = raw.match(/^(---\n)([\s\S]*?)(\n---\n*)/);
				if (fmMatch) {
					if (!/^status:/m.test(fmMatch[2])) {
						page = `${fmMatch[1]}status: "draft"\n${fmMatch[2]}${fmMatch[3]}`;
					} else {
						page = raw.replace(/^(status:\s*).*$/m, '$1"draft"');
					}
				} else {
					page = `---\nstatus: "draft"\n---\n\n${raw}`;
				}
				await writeWikiFile(this.app, this.settings.wikiFolder, task.path, page);
				generated.push(task.path);
			} catch (e: any) {
				errors.push({ name: task.name, error: e.message });
			}
		}

		return { generated, errors };
	}
}

class SecondBrainSettingTab extends PluginSettingTab {
	plugin: SecondBrain;

	constructor(app: App, plugin: SecondBrain) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const lang = this.plugin.settings.language;

		containerEl.createEl("h2", { text: t("set.title", lang) });

		new Setting(containerEl)
			.setName(t("set.provider", lang))
			.addDropdown((dd) => dd
				.addOptions({ deepseek: "DeepSeek", openai: "OpenAI", anthropic: "Anthropic (Claude)", openrouter: "OpenRouter", custom: "Custom" })
				.setValue(this.plugin.settings.provider)
				.onChange(async (v) => { this.plugin.settings.provider = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.model", lang))
			.addText((t2) => t2.setPlaceholder(t("set.modelPh", lang)).setValue(this.plugin.settings.model).onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); }));

		const apiKeySetting = new Setting(containerEl)
			.setName(t("set.apiKey", lang))
			.setDesc(t("set.apiKeyDesc", lang))
			.addText((t2) => { t2.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey).onChange(async (v) => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }); t2.inputEl.type = "password"; });
		apiKeySetting.descEl.createEl("a", { text: t("set.getApiKey", lang), href: "https://platform.deepseek.com/api_keys" });

		new Setting(containerEl)
			.setName(t("set.baseUrl", lang))
			.addText((t2) => t2.setPlaceholder(t("set.baseUrlPh", lang)).setValue(this.plugin.settings.baseUrl).onChange(async (v) => { this.plugin.settings.baseUrl = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.testConn", lang))
			.addButton((btn) => btn.setButtonText(t("set.test", lang)).onClick(async () => {
				try {
					const reply = await callLLM([{ role: "user", content: "Hi" }], this.plugin.settings, { maxTokens: 10, temperature: 0 });
					new Notice(t("notice.connOk", lang, { msg: reply }));
				} catch (e: any) {
					new Notice(t("notice.connFail", lang, { msg: e.message }));
				}
			}));

		containerEl.createEl("h3", { text: t("set.autoSection", lang) });

		new Setting(containerEl)
			.setName(t("set.autoCompile", lang))
			.setDesc(t("set.autoCompileDesc", lang))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoCompile)
				.onChange(async (v) => { this.plugin.settings.autoCompile = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName(t("set.delay", lang))
			.setDesc(t("set.delayDesc", lang))
			.addSlider((slider) => slider
				.setLimits(10, 120, 5)
				.setValue(this.plugin.settings.autoCompileDelay)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.autoCompileDelay = v; await this.plugin.saveSettings(); }));


				containerEl.createEl("h3", { text: t("set.embedSection", lang) });

				new Setting(containerEl)
					.setName(t("set.embedModel", lang))
					.setDesc(t("set.embedModelDesc", lang))
					.addText((t2) => t2.setPlaceholder(t("set.embedModelPh", lang)).setValue(this.plugin.settings.embeddingModel).onChange(async (v) => { this.plugin.settings.embeddingModel = v; await this.plugin.saveSettings(); }));

				new Setting(containerEl)
					.setName(t("set.embedUrl", lang))
					.setDesc(t("set.embedUrlDesc", lang))
					.addText((t2) => t2.setPlaceholder(t("set.embedUrlPh", lang)).setValue(this.plugin.settings.embeddingBaseUrl).onChange(async (v) => { this.plugin.settings.embeddingBaseUrl = v; await this.plugin.saveSettings(); }));

				new Setting(containerEl)
					.setName(t("set.embedKey", lang))
					.setDesc(t("set.embedKeyDesc", lang))
					.addText((t2) => { t2.setPlaceholder("sk-...").setValue(this.plugin.settings.embeddingApiKey).onChange(async (v) => { this.plugin.settings.embeddingApiKey = v; await this.plugin.saveSettings(); }); t2.inputEl.type = "password"; });

			containerEl.createEl("h3", { text: t("set.langSection", lang) });

			new Setting(containerEl)
				.setName(t("set.language", lang))
				.setDesc(t("set.languageDesc", lang))
				.addDropdown((dd) => dd
					.addOptions({ "auto": "Auto (Obsidian)", "zh-CN": "简体中文", "en": "English", "ja": "日本語" })
					.setValue(this.plugin.settings.language)
					.onChange(async (v) => { this.plugin.settings.language = v; await this.plugin.saveSettings(); this.display(); }));

			new Setting(containerEl)
				.setName(t("set.tplFile", lang))
				.setDesc(t("set.tplFileDesc", lang))
				.addText((t2) => t2.setPlaceholder(t("set.tplFilePh", lang)).setValue(this.plugin.settings.templateFile).onChange(async (v) => { this.plugin.settings.templateFile = v; await this.plugin.saveSettings(); }));

			new Setting(containerEl)
				.setName(t("set.genTpl", lang))
				.setDesc(t("set.genTplDesc", lang))
				.addButton((btn) => btn.setButtonText(t("set.gen", lang)).onClick(async () => {
					try {
						const { generateTemplateFile } = await import("./core/templates");
						await generateTemplateFile(this.app, this.plugin.settings.templateFile, this.plugin.settings.language);
						new Notice(t("notice.tplGenerated", lang, { path: this.plugin.settings.templateFile }));
					} catch (e: any) {
						new Notice(t("notice.tplFail", lang, { msg: e.message }));
					}
				}));

			containerEl.createEl("h3", { text: t("set.folderSection", lang) });

			new Setting(containerEl)
				.setName(t("set.rawFolder", lang))
				.setDesc(t("set.rawFolderDesc", lang))
				.addText((t2) => t2.setPlaceholder(t("set.rawFolderPh", lang)).setValue(this.plugin.settings.rawFolder).onChange(async (v) => { this.plugin.settings.rawFolder = v; await this.plugin.saveSettings(); }));

			new Setting(containerEl)
				.setName(t("set.wikiFolder", lang))
				.setDesc(t("set.wikiFolderDesc", lang))
				.addText((t2) => t2.setPlaceholder(t("set.wikiFolderPh", lang)).setValue(this.plugin.settings.wikiFolder).onChange(async (v) => { this.plugin.settings.wikiFolder = v; await this.plugin.saveSettings(); }));

				// --- 数据管理 ---
				containerEl.createEl("h3", { text: t("set.dataSection", lang) });

				new Setting(containerEl)
					.setName(t("set.cleanWiki", lang))
					.setDesc(t("set.cleanWikiDesc", lang))
					.addButton((btn) => btn.setButtonText(t("set.cleanWikiBtn", lang)).setWarning().onClick(async () => {
						const modal = new Modal(this.app);
						modal.contentEl.createEl("h3", { text: t("set.confirmTitle", lang) });
						modal.contentEl.createEl("p", { text: t("set.confirmDesc", lang) });
						modal.contentEl.createEl("p", { text: t("set.confirmHint", lang) });
						const input = modal.contentEl.createEl("input", { type: "text", placeholder: t("set.confirmPh", lang) });

						const btnRow = modal.contentEl.createDiv();
						btnRow.style.display = "flex";
						btnRow.style.gap = "8px";
						btnRow.style.justifyContent = "flex-end";

						const cancelBtn = btnRow.createEl("button", { text: t("set.cancel", lang) });
						cancelBtn.addEventListener("click", () => modal.close());

						const confirmBtn = btnRow.createEl("button", { text: t("set.confirmBtn", lang), cls: "mod-warning" });
						confirmBtn.addEventListener("click", async () => {
							if (input.value !== "CONFIRM") {
								new Notice(t("notice.pleaseConfirm", lang));
								return;
							}
							confirmBtn.disabled = true;
							confirmBtn.textContent = t("set.cleaning", lang);
							try {
								const wikiFolder = this.plugin.settings.wikiFolder;
								const wikiFiles = await readWikiFiles(this.app, wikiFolder);
								for (const f of wikiFiles) {
									const fullPath = `${wikiFolder}/${f.path}`;
									const file = this.app.vault.getAbstractFileByPath(fullPath);
									if (file instanceof TFile) {
										await this.app.vault.delete(file);
									}
								}
								this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS, emptyCache());
								await this.plugin.saveData(this.plugin.settings);
								new Notice(t("notice.wikiCleaned", lang, { n: wikiFiles.length }));
								modal.close();
							} catch (e: any) {
								new Notice(t("notice.cleanFail", lang, { msg: e.message }));
								confirmBtn.disabled = false;
								confirmBtn.textContent = t("set.confirmBtn", lang);
							}
						});
						modal.open();
					}));

				new Setting(containerEl)
					.setName(t("set.cleanCache", lang))
					.setDesc(t("set.cleanCacheDesc", lang))
					.addButton((btn) => btn.setButtonText(t("set.cleanCacheBtn", lang)).setWarning().onClick(async () => {
						this.plugin.settings = Object.assign({}, this.plugin.settings, emptyCache());
						await this.plugin.saveData(this.plugin.settings);
						clearEmbeddingCache();
						new Notice(t("notice.cacheCleaned", lang));
					}));
	}
}

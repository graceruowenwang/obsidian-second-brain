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
import { readRawFiles, readWikiFiles, writeWikiFile, diffFingerprints, emptyCache, filesToMap } from "./core/file-utils";
import { callLLM } from "./core/llm";
import {
	buildIncrementalAnalyzePrompt, buildConceptPrompt, buildEntityPrompt, buildSourcePrompt,
} from "./core/wiki-schema";

export default class SecondBrain extends Plugin {
	settings!: PluginSettings;
	private autoCompileTimer: ReturnType<typeof setTimeout> | null = null;
	private isCompiling = false;

	async onload() {
		await this.loadSettings();

		// 注册 View
		this.registerView(VIEW_TYPE_COMPILE, (leaf) => new CompileView(leaf, this as SecondBrainPlugin));
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this as SecondBrainPlugin));
		this.registerView(VIEW_TYPE_WIKI, (leaf) => new WikiView(leaf, this as SecondBrainPlugin));

		// 左侧栏图标
		this.addRibbonIcon("zap", "编译 Wiki", () => this.activateView(VIEW_TYPE_COMPILE));
		this.addRibbonIcon("message-circle", "Wiki 对话", () => this.activateView(VIEW_TYPE_CHAT));
		this.addRibbonIcon("globe", "Wiki 预览", () => this.activateView(VIEW_TYPE_WIKI));

		// 命令：编译全部
		this.addCommand({
			id: "compile-all",
			name: "编译全部素材",
			callback: () => this.activateView(VIEW_TYPE_COMPILE),
		});

		// 命令：编译当前文件
		this.addCommand({
			id: "compile-current",
			name: "编译当前文件",
			editorCallback: (editor: Editor, view: MarkdownView) => this.compileCurrentFile(view),
		});

		// 命令：打开对话
		this.addCommand({
			id: "open-chat",
			name: "和 Wiki 对话",
			callback: () => this.activateView(VIEW_TYPE_CHAT),
		});

		// 命令：打开 Wiki 预览
		this.addCommand({
			id: "open-wiki",
			name: "打开 Wiki 预览",
			callback: () => this.activateView(VIEW_TYPE_WIKI),
		});

		// 设置面板
		this.addSettingTab(new SecondBrainSettingTab(this.app, this));

		// 自动编译：监听 raw/ 目录文件变化
		this.registerEvent(this.app.vault.on("create", (file) => this.onRawFileChange(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.onRawFileChange(file)));

		// 启动时自动检查是否有新素材需要编译
		if (this.settings.autoCompile && this.settings.apiKey) {
			this.startupAutoCompile();
		}

		console.log("第二大脑插件已加载");
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
				new Notice(`检测到 ${changed.length} 个新素材，开始自动编译...`);
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
				new Notice(`自动编译完成：${total} 个页面已更新`);
			}
		} catch (e: any) {
			console.error("自动编译失败:", e.message);
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
				// 对话面板在主编辑区打开（全宽）
				leaf = workspace.getLeaf(true);
				await leaf.setViewState({ type: viewType, active: true });
			} else {
				// 编译面板在右侧栏
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
			new Notice("请先在设置中配置 API Key");
			return;
		}

		const content = await this.app.vault.read(file);
		const targetFile = { path: file.path, content };

		new Notice(`正在编译 ${file.path}...`);

		try {
			const wikiFiles = await readWikiFiles(this.app, this.settings.wikiFolder);
			const wikiMap: Record<string, string> = {};
			for (const f of wikiFiles) wikiMap[f.path] = f.content;

			const result = await this.quickIngest(targetFile);
			new Notice(`编译完成：${result.generated.length} 个页面`);
		} catch (e: any) {
			new Notice(`编译失败: ${e.message}`);
		}
	}

	private async quickIngest(targetFile: { path: string; content: string }) {
		const allFiles = await readRawFiles(this.app, this.settings.rawFolder);
		const wikiFiles = await readWikiFiles(this.app, this.settings.wikiFolder);
		const existingNames = Object.keys(filesToMap(wikiFiles)).map(p => p.split("/").pop()!.replace(/\.md$/, ""));

		const changedMaterials = `--- 文件: ${targetFile.path} ---\n${targetFile.content.slice(0, 4000)}`;
		const prompt = buildIncrementalAnalyzePrompt(changedMaterials, existingNames);

		const analysisResult = await callLLM(
			[{ role: "system", content: "你是知识管理专家。输出严格的 JSON。" }, { role: "user", content: prompt }],
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
			if (task.type === "concept") { genPrompt = buildConceptPrompt(task.item, task.materials, concepts); system = "你是知识库编辑。"; }
			else if (task.type === "entity") { genPrompt = buildEntityPrompt(task.item, task.materials, concepts); system = "你是知识库编辑。"; }
			else { genPrompt = buildSourcePrompt(task.item, task.materials, concepts); system = "你是知识库编辑。"; }

			try {
				const page = await callLLM([{ role: "system", content: system }, { role: "user", content: genPrompt }], this.settings, { temperature: 0.3 });
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

		containerEl.createEl("h2", { text: "第二大脑 — 设置" });

		new Setting(containerEl)
			.setName("LLM Provider")
			.addDropdown((dd) => dd
				.addOptions({ deepseek: "DeepSeek", openai: "OpenAI", anthropic: "Anthropic (Claude)", openrouter: "OpenRouter", custom: "Custom" })
				.setValue(this.plugin.settings.provider)
				.onChange(async (v) => { this.plugin.settings.provider = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Model")
			.addText((t) => t.setPlaceholder("deepseek-chat").setValue(this.plugin.settings.model).onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("密钥保存在本地，不会上传")
			.addText((t) => { t.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey).onChange(async (v) => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }); t.inputEl.type = "password"; });

		new Setting(containerEl)
			.setName("Base URL")
			.addText((t) => t.setPlaceholder("https://api.deepseek.com").setValue(this.plugin.settings.baseUrl).onChange(async (v) => { this.plugin.settings.baseUrl = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("测试连接")
			.addButton((btn) => btn.setButtonText("测试").onClick(async () => {
				try {
					const reply = await callLLM([{ role: "user", content: "回复两个字：正常" }], this.plugin.settings, { maxTokens: 10, temperature: 0 });
					new Notice(`连接成功: ${reply}`);
				} catch (e: any) {
					new Notice(`连接失败: ${e.message}`);
				}
			}));

		containerEl.createEl("h3", { text: "自动编译" });

		new Setting(containerEl)
			.setName("自动编译")
			.setDesc("检测到 raw/ 目录有新素材或修改时，自动触发增量编译")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoCompile)
				.onChange(async (v) => { this.plugin.settings.autoCompile = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("编译延迟（秒）")
			.setDesc("文件修改后等待多少秒再触发编译，避免频繁调用 API")
			.addSlider((slider) => slider
				.setLimits(10, 120, 5)
				.setValue(this.plugin.settings.autoCompileDelay)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.autoCompileDelay = v; await this.plugin.saveSettings(); }));

		containerEl.createEl("h3", { text: "目录配置" });

		new Setting(containerEl)
			.setName("素材目录")
			.setDesc("存放原始素材的文件夹")
			.addText((t) => t.setPlaceholder("raw").setValue(this.plugin.settings.rawFolder).onChange(async (v) => { this.plugin.settings.rawFolder = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Wiki 目录")
			.setDesc("AI 编译输出的文件夹")
			.addText((t) => t.setPlaceholder("wiki").setValue(this.plugin.settings.wikiFolder).onChange(async (v) => { this.plugin.settings.wikiFolder = v; await this.plugin.saveSettings(); }));

			// --- 数据管理 ---
			containerEl.createEl("h3", { text: "数据管理" });

			new Setting(containerEl)
				.setName("清理 Wiki")
				.setDesc("删除所有 AI 编译生成的 wiki 页面和编译缓存")
				.addButton((btn) => btn.setButtonText("清理 Wiki").setWarning().onClick(async () => {
					const modal = new Modal(this.app);
					modal.contentEl.createEl("h3", { text: "确认清理 Wiki" });
					modal.contentEl.createEl("p", { text: "即将删除所有 wiki 页面和编译缓存。该操作不可撤销。" });
					modal.contentEl.createEl("p", { text: "要继续，请输入 CONFIRM" });
					const input = modal.contentEl.createEl("input", { type: "text", placeholder: "CONFIRM" });

					const btnRow = modal.contentEl.createDiv();
					btnRow.style.display = "flex";
					btnRow.style.gap = "8px";
					btnRow.style.justifyContent = "flex-end";

					const cancelBtn = btnRow.createEl("button", { text: "取消" });
					cancelBtn.addEventListener("click", () => modal.close());

					const confirmBtn = btnRow.createEl("button", { text: "确认清理", cls: "mod-warning" });
					confirmBtn.addEventListener("click", async () => {
						if (input.value !== "CONFIRM") {
							new Notice("请输入 CONFIRM 确认");
							return;
						}
						confirmBtn.disabled = true;
						confirmBtn.textContent = "清理中...";
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
							new Notice(`Wiki 已清理，删除了 ${wikiFiles.length} 个文件`);
							modal.close();
						} catch (e: any) {
							new Notice(`清理失败: ${e.message}`);
							confirmBtn.disabled = false;
							confirmBtn.textContent = "确认清理";
						}
					});
					modal.open();
				}));

			new Setting(containerEl)
				.setName("清理编译缓存")
				.setDesc("仅清理编译缓存（指纹、分析结果），不删除 wiki 页面，下次编译将全量重新分析")
				.addButton((btn) => btn.setButtonText("清理缓存").setWarning().onClick(async () => {
					this.plugin.settings = Object.assign({}, this.plugin.settings, emptyCache());
					await this.plugin.saveData(this.plugin.settings);
					new Notice("编译缓存已清理");
				}));
	}
}

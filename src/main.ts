// 第二大脑 — Obsidian 插件入口

import {
	Editor, MarkdownView, Modal, Notice, Plugin,
	TFile, TFolder,
} from "obsidian";
import { DEFAULT_SETTINGS, type PluginSettings, type LicenseInfo, type SecondBrainPlugin, type CompileCache } from "./types";
import { CompileView, VIEW_TYPE_COMPILE } from "./views/compile-view";
import { ChatView, VIEW_TYPE_CHAT } from "./views/chat-view";
import { WikiView, VIEW_TYPE_WIKI } from "./views/wiki-view";
import { runCompile } from "./core/compile";
import { readRawFiles, diffFingerprints, emptyCache } from "./core/file-utils";
import { t } from "./core/i18n";
import { SetupWizardModal } from "./ui/setup-wizard";
import { validateLicense, isPro, needsRevalidation, enterGraceIfNeeded, checkGraceExpiry, checkTrialExpiry, getDefaultLicense, getTrialLicense } from "./core/license";
import { requirePro, showUpgradeNotice } from "./core/feature-gate";
import { quickIngest } from "./core/quick-ingest";

export default class SecondBrain extends Plugin {
	settings!: PluginSettings;
	licenseInfo: LicenseInfo = getDefaultLicense();
	private autoCompileTimer: ReturnType<typeof setTimeout> | null = null;
	private isCompiling = false;
	private statusBarItem: HTMLElement | null = null;
	private settingsTab: SecondBrainSettingTab | null = null;

	getLicenseState(): LicenseInfo {
		return this.licenseInfo;
	}

	async onload() {
		await this.loadSettings();
		await this.loadLicenseInfo();
		const lang = this.settings.language;

		// 老用户兼容：已有 setup 但无 license → 14 天 Pro 试用
		if (this.settings.setupCompleted && !this.settings.licenseKey && this.licenseInfo.plan === "free") {
			this.licenseInfo = getTrialLicense();
			await this.saveLicenseInfo();
			new Notice(t("license.trialNotice", lang));
		}

		// Pro 激活引导（仅首次）
		if (isPro(this.licenseInfo) && !this.settings.proWelcomeShown) {
			this.settings.proWelcomeShown = true;
			await this.saveSettings();
			this.showProWelcome(lang);
		}

		// 注册 View
		this.registerView(VIEW_TYPE_COMPILE, (leaf) => new CompileView(leaf, this as unknown as SecondBrainPlugin));
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this as unknown as SecondBrainPlugin));
		this.registerView(VIEW_TYPE_WIKI, (leaf) => new WikiView(leaf, this as unknown as SecondBrainPlugin));

		// 左侧栏图标
		const ribbonCompile = this.addRibbonIcon("zap", t("cmd.compileWiki", lang), () => this.activateView(VIEW_TYPE_COMPILE));
		ribbonCompile.setAttribute("aria-label", t("cmd.compileWiki", lang));
		const ribbonChat = this.addRibbonIcon("message-circle", t("cmd.wikiChat", lang), () => {
			if (!requirePro(this.licenseInfo, "ai-chat")) {
				showUpgradeNotice(this.app, "ai-chat", lang);
				return;
			}
			this.activateView(VIEW_TYPE_CHAT);
		});
		ribbonChat.setAttribute("aria-label", t("cmd.wikiChat", lang));
		const ribbonWiki = this.addRibbonIcon("globe", t("cmd.wikiPreview", lang), () => this.activateView(VIEW_TYPE_WIKI));
		ribbonWiki.setAttribute("aria-label", t("cmd.wikiPreview", lang));

		// 命令：编译全部
		this.addCommand({
			id: "compile-all",
			name: t("cmd.compileAll", lang),
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "c" }],
			callback: () => this.activateView(VIEW_TYPE_COMPILE),
		});

		// 命令：编译当前文件
		this.addCommand({
			id: "compile-current",
			name: t("cmd.compileCurrent", lang),
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "x" }],
			editorCallback: (_editor: Editor, view: MarkdownView) => this.compileCurrentFile(view),
		});

		// 命令：打开对话（Pro）
		this.addCommand({
			id: "open-chat",
			name: t("cmd.openChat", lang),
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "d" }],
			callback: () => {
				if (!requirePro(this.licenseInfo, "ai-chat")) {
					showUpgradeNotice(this.app, "ai-chat", lang);
					return;
				}
				this.activateView(VIEW_TYPE_CHAT);
			},
		});

		// 命令：打开 Wiki 预览
		this.addCommand({
			id: "open-wiki",
			name: t("cmd.openWiki", lang),
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "w" }],
			callback: () => this.activateView(VIEW_TYPE_WIKI),
		});

		// 命令：捕获当前笔记到 inbox
		this.addCommand({
			id: "capture-to-inbox",
			name: "Capture current note to inbox",
			hotkeys: [{ modifiers: ["Mod", "Shift"], key: "i" }],
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				const file = view.file;
				if (!file) return;
				const content = editor.getValue();
				if (!content.trim()) { new Notice("Empty note"); return; }
				const today = new Date().toISOString().split("T")[0];
				const title = file.basename || today;
				const inboxPath = `${this.settings.rawFolder}/06-flash_notes/inbox/${today}-${title}.md`;
				const existing = this.app.vault.getAbstractFileByPath(inboxPath);
				if (existing instanceof TFile) {
					const merged = (await this.app.vault.read(existing)) + "\n\n---\n\n" + content;
					await this.app.vault.modify(existing, merged);
				} else {
					const folderPath = inboxPath.substring(0, inboxPath.lastIndexOf("/"));
					const parts = folderPath.split("/");
					let current = "";
					for (const part of parts) {
						current = current ? `${current}/${part}` : part;
						if (!this.app.vault.getAbstractFileByPath(current)) {
							await this.app.vault.createFolder(current);
						}
					}
					await this.app.vault.create(inboxPath, content);
				}
				new Notice(`Captured to ${inboxPath}`);
			},
		});

		// 设置面板
		this.settingsTab = new SecondBrainSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		// 自动编译：仅 Pro 用户
		if (requirePro(this.licenseInfo, "auto-compile")) {
			this.registerEvent(this.app.vault.on("create", (file) => this.onRawFileChange(file as TFile | TFolder)));
			this.registerEvent(this.app.vault.on("modify", (file) => this.onRawFileChange(file as TFile | TFolder)));
		}

		// 状态栏
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar("ready");

		// 首次使用向导
		if (!this.settings.setupCompleted) {
			new SetupWizardModal(this.app, this).open();
		}

		// 启动时自动检查是否有新素材需要编译（Pro only）
		if (requirePro(this.licenseInfo, "auto-compile") && this.settings.autoCompile && this.settings.apiKey) {
			this.startupAutoCompile();
		}

		// 后台定期重新验证 License
		if (this.settings.licenseKey && needsRevalidation(this.licenseInfo)) {
			this.backgroundRevalidate();
		}
		this.registerInterval(
			window.setInterval(() => this.backgroundRevalidate(), 24 * 60 * 60 * 1000)
		);

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

	// --- 数据持久化 ---

	private async loadPluginData(): Promise<Record<string, unknown>> {
		return (await this.loadData()) as Record<string, unknown> || {};
	}

	private async savePluginData(data: Record<string, unknown>): Promise<void> {
		await this.saveData(data);
	}

	// --- License ---

	async loadLicenseInfo() {
		const data = await this.loadPluginData();
		if (data._licenseInfo) {
			this.licenseInfo = checkTrialExpiry(checkGraceExpiry(data._licenseInfo as LicenseInfo));
		} else {
			this.licenseInfo = getDefaultLicense();
		}
	}

	async saveLicenseInfo() {
		const data = await this.loadPluginData();
		data._licenseInfo = this.licenseInfo as unknown;
		await this.savePluginData(data);
	}

	private async backgroundRevalidate() {
		if (!this.settings.licenseKey) return;
		try {
			const result = await validateLicense(this.settings.licenseKey);
			this.licenseInfo = result;
			await this.saveLicenseInfo();
		} catch {
			this.licenseInfo = enterGraceIfNeeded(this.licenseInfo);
			this.licenseInfo = checkGraceExpiry(this.licenseInfo);
			await this.saveLicenseInfo();
		}
	}

	refreshSettingsTab() {
		if (this.settingsTab) this.settingsTab.display();
	}

	private showProWelcome(lang: string) {
		new Notice(t("pro.trialStarted", lang));
	}

	// --- 状态栏 ---

	updateStatusBar(state: "ready" | "compiling" | "pending", count?: number) {
		if (!this.statusBarItem) return;
		const lang = this.settings.language;
		const pro = isPro(this.licenseInfo);
		if (state === "ready") {
			this.statusBarItem.setText(pro ? t("pro.statusReady", lang) : t("sb.ready", lang));
		} else if (state === "compiling") {
			this.statusBarItem.setText(pro ? t("pro.statusCompiling", lang) : t("sb.compiling", lang));
		} else if (state === "pending") {
			this.statusBarItem.setText(pro ? t("pro.statusPending", lang) : t("sb.pending", lang, { n: count || 0 }));
		}
	}

	async loadSettings() {
		const saved = await this.loadPluginData();
		if (saved.outputLanguage && !saved.language) {
			saved.language = saved.outputLanguage;
			delete saved.outputLanguage;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
	}

	async saveSettings() {
		const data = await this.loadPluginData();
		Object.assign(data, this.settings);
		data._licenseInfo = this.licenseInfo as unknown;
		await this.savePluginData(data);
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
		if (!requirePro(this.licenseInfo, "auto-compile")) return;
		if (!this.isRawFile(file)) return;

		if (this.autoCompileTimer) clearTimeout(this.autoCompileTimer);
		this.updateStatusBar("pending", 1);
		this.autoCompileTimer = setTimeout(() => {
			this.autoCompileTimer = null;
			this.triggerAutoCompile();
		}, this.settings.autoCompileDelay * 1000);
	}

	private async startupAutoCompile() {
		try {
			const allFiles = await readRawFiles(this.app, this.settings.rawFolder);
			if (allFiles.length === 0) return;

			const cache = (await this.loadData()) as CompileCache || emptyCache();
			const { changed } = diffFingerprints(allFiles, cache);
			if (changed.length > 0) {
				new Notice(t("notice.detectNew", this.settings.language, { n: changed.length }));
				this.triggerAutoCompile();
			}
		} catch {
		}
	}

	private async triggerAutoCompile() {
		if (this.isCompiling) return;
		if (!this.settings.apiKey) return;

		this.isCompiling = true;
		this.updateStatusBar("compiling");
		try {
			const result = await runCompile(this.app, this.settings, undefined, false, this);
			const total = result.conceptsCount + result.entitiesCount + result.sourcesCount;
			if (!result.reused) {
				new Notice(t("notice.autoDone", this.settings.language, { n: total }));
			}
		} catch (e: unknown) {
			console.error("Auto compile failed:", (e instanceof Error ? e.message : String(e)));
		} finally {
			this.isCompiling = false;
			this.updateStatusBar("ready");
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

		const lang = this.settings.language;
		const modal = new Modal(this.app);
		modal.contentEl.createEl("h3", { text: t("set.compileFileTitle", lang) });
		modal.contentEl.createEl("p", { text: t("set.compileFileDesc", lang, { path: file.path }) });

		const btnRow = modal.contentEl.createDiv();
		btnRow.style.display = "flex";
		btnRow.style.gap = "8px";
		btnRow.style.justifyContent = "flex-end";

		const cancelBtn = btnRow.createEl("button", { text: t("set.cancel", lang) });
		cancelBtn.addEventListener("click", () => modal.close());

		const confirmBtn = btnRow.createEl("button", { text: t("compile.start", lang), cls: "mod-cta" });
		confirmBtn.addEventListener("click", async () => {
			modal.close();
			new Notice(t("notice.compiling", lang, { path: file.path }));
			try {
				const content = await this.app.vault.read(file);
				const targetFile = { path: file.path, content };
				const result = await quickIngest(this.app, this.settings, targetFile);
				new Notice(t("notice.compileDone", lang, { n: result.generated.length }));
			} catch (e: unknown) {
				new Notice(t("notice.compileFail", lang, { msg: (e instanceof Error ? e.message : String(e)) }));
			}
		});
		modal.open();
	}
}

import { SecondBrainSettingTab } from "./ui/settings-tab";

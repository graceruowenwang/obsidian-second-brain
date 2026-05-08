// 第二大脑 — Obsidian 插件入口

import {
	Editor, MarkdownFileInfo, MarkdownView, Modal, Notice, Plugin,
	TFile, TFolder,
} from "obsidian";
import { coercePluginSettings } from "./core/coerce-settings";
import { DEFAULT_SETTINGS, type PluginSettings, type LicenseInfo, type SecondBrainPlugin, type CompileCache } from "./types";
import { CompileView, VIEW_TYPE_COMPILE } from "./views/compile-view";
import { ChatView, VIEW_TYPE_CHAT } from "./views/chat-view";
import { WikiView, VIEW_TYPE_WIKI } from "./views/wiki-view";
import { runCompile } from "./core/compile";
import { readRawFiles, diffFingerprints, emptyCache, clearEmbeddingCache } from "./core/file-utils";
import { t } from "./core/i18n";
import { SetupWizardModal } from "./ui/setup-wizard";
import { validateLicense, isPro, needsRevalidation, enterGraceIfNeeded, checkGraceExpiry, checkTrialExpiry, getDefaultLicense, getTrialLicense, getTrialDaysLeft, isTrialActive } from "./core/license";
import { requirePro, showUpgradeNotice } from "./core/feature-gate";
import { quickIngest } from "./core/quick-ingest";
import { SecondBrainSettingTab } from "./ui/settings-tab";
import { encryptKeys, decryptKeys, isEncryptionAvailable, SecureStorageError } from "./core/secure-storage";
import { describeLLMFailure } from "./core/llm-user-message";
import { organizeLooseRawFiles, RAW_FLASH_INBOX } from "./core/raw-organize";

/** 编译互斥锁：串行化所有对 wiki 文件的写入路径 */
class AsyncMutex {
	private queue: Promise<unknown> = Promise.resolve();
	private _locked = false;

	get locked(): boolean {
		return this._locked;
	}

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((resolve) => { release = resolve; });
		try {
			await prev.catch(() => void 0);
			this._locked = true;
			return await fn();
		} finally {
			this._locked = false;
			release();
		}
	}
}

export default class SecondBrain extends Plugin implements SecondBrainPlugin {
	settings!: PluginSettings;
	licenseInfo: LicenseInfo = getDefaultLicense();
	private autoCompileTimer: ReturnType<typeof setTimeout> | null = null;
	private compileMutex = new AsyncMutex();
	private statusBarItem: HTMLElement | null = null;
	private settingsTab: SecondBrainSettingTab | null = null;

	getLicenseState(): LicenseInfo {
		return this.licenseInfo;
	}

	/**
	 * 串行化所有对 data.json / wiki 文件的写入路径，防止 autoCompile / 手动编译
	 * / quickIngest 并发时互相覆盖 cache。所有编译入口都应通过此方法。
	 */
	async runWithCompileLock<T>(fn: () => Promise<T>): Promise<T> {
		const result = await this.compileMutex.runExclusive(fn);
		(this.app.workspace as unknown as { trigger: (event: string) => void }).trigger("second-brain:compile-complete");
		return result;
	}

	/** 将素材目录根下散落的文件移入标准子文件夹（不调用 LLM） */
	async organizeRawMaterials(): Promise<void> {
		const lang = this.settings.language;
		const rawFolder = this.settings.rawFolder;
		try {
			const result = await organizeLooseRawFiles(this.app, rawFolder);
			for (const e of result.errors) {
				console.warn("organize raw:", e.path, e.message);
			}
			const onlyFolderMissing = result.errors.length > 0 && result.moved.length === 0
				&& result.errors.every((e) => e.path === rawFolder);
			if (onlyFolderMissing) {
				new Notice(t("notice.organizeRawFail", lang, { msg: result.errors[0]?.message || "unknown" }));
				return;
			}
			if (result.errors.length > 0) {
				new Notice(t("notice.organizeRawPartial", lang, { moved: result.moved.length, err: result.errors.length }));
			} else if (result.moved.length === 0) {
				new Notice(t("notice.organizeRawNone", lang));
			} else {
				new Notice(t("notice.organizeRawDone", lang, { n: result.moved.length }));
			}
		} catch (e) {
			new Notice(t("notice.organizeRawFail", lang, { msg: (e as Error).message }));
		}
	}

	async onload() {
		await this.loadSettings();
		await this.loadLicenseInfo();
		const lang = this.settings.language;

		// 老用户兼容：已有 setup 但无 license → 14 天 Pro 试用
		if (this.settings.setupCompleted && !this.settings.licenseKey && this.licenseInfo.plan === "free") {
			this.licenseInfo = getTrialLicense();
			await this.saveLicenseInfo();
			new Notice(t("license.trialNotice", lang, { days: getTrialDaysLeft(this.licenseInfo) }));
		}

		// Pro 激活引导（仅首次）
		if (isPro(this.licenseInfo) && !this.settings.proWelcomeShown) {
			this.settings.proWelcomeShown = true;
			await this.saveSettings();
			this.showProWelcome(lang);
		}

		// 试用到期提醒：剩余 <= 3 天时每次启动提醒，到期时明确告知
		if (isTrialActive(this.licenseInfo)) {
			const daysLeft = getTrialDaysLeft(this.licenseInfo);
			if (daysLeft <= 3) {
				new Notice(t("pro.trialExpiring", lang, { days: String(daysLeft) }), 6000);
			}
		} else if (this.licenseInfo.status === "trial" && this.licenseInfo.trialStart) {
			// trial status 但已过期 -> checkTrialExpiry 会重置为 free，这是首次检测到过期
			if (!this.licenseInfo.trialExpiredShown) {
				this.licenseInfo.trialExpiredShown = true;
				await this.saveLicenseInfo();
				new Notice(t("pro.trialExpiredNotice", lang), 8000);
			}
		}

		// 注册 View
		this.registerView(VIEW_TYPE_COMPILE, (leaf) => new CompileView(leaf, this));
		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
		this.registerView(VIEW_TYPE_WIKI, (leaf) => new WikiView(leaf, this));

		// 左侧栏图标
		const ribbonCompile = this.addRibbonIcon("zap", t("cmd.compileWiki", lang), () => this.activateView(VIEW_TYPE_COMPILE));
		ribbonCompile.setAttribute("aria-label", t("cmd.compileWiki", lang));
		const ribbonChat = this.addRibbonIcon("message-circle", t("cmd.wikiChat", lang), () => {
			if (!requirePro(this.licenseInfo, "ai-chat")) {
				showUpgradeNotice(this.app, "ai-chat", lang);
				return;
			}
			void this.activateView(VIEW_TYPE_CHAT);
		});
		ribbonChat.setAttribute("aria-label", t("cmd.wikiChat", lang));
	const ribbonWiki = this.addRibbonIcon("globe", t("cmd.wikiPreview", lang), () => { void this.activateView(VIEW_TYPE_WIKI); });
		ribbonWiki.setAttribute("aria-label", t("cmd.wikiPreview", lang));

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
			editorCallback: (_editor: Editor, view: MarkdownView | MarkdownFileInfo) => this.compileCurrentFile(view as MarkdownView),
		});

		// 命令：打开对话（Pro）
		this.addCommand({
			id: "open-chat",
			name: t("cmd.openChat", lang),
			callback: () => {
				if (!requirePro(this.licenseInfo, "ai-chat")) {
					showUpgradeNotice(this.app, "ai-chat", lang);
					return;
				}
				void this.activateView(VIEW_TYPE_CHAT);
			},
		});

		// 命令：打开 Wiki 预览
		this.addCommand({
			id: "open-wiki",
			name: t("cmd.openWiki", lang),
			callback: () => { void this.activateView(VIEW_TYPE_WIKI); },
		});

		// 命令：整理 raw 根目录散落文件
		this.addCommand({
			id: "organize-raw",
			name: t("cmd.organizeRaw", lang),
			callback: () => { void this.organizeRawMaterials(); },
		});

		// 命令：捕获当前笔记到闪念收件箱
		this.addCommand({
			id: "capture-to-inbox",
			name: t("cmd.captureToInbox", lang),
			editorCallback: async (editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
				const file = (view as MarkdownView).file;
				if (!file) return;
				const content = editor.getValue();
				if (!content.trim()) { new Notice(t("notice.emptyNote", lang)); return; }
				const today = new Date().toISOString().split("T")[0];
				const title = file.basename || today;
				const inboxPath = `${this.settings.rawFolder}/${RAW_FLASH_INBOX}/${today}-${title}.md`;
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
				new Notice(t("notice.capturedTo", lang, { path: inboxPath }));
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
			void this.startupAutoCompile();
		}

		// 后台定期重新验证 License
		if (this.settings.licenseKey && needsRevalidation(this.licenseInfo)) {
			void this.backgroundRevalidate();
		}
		this.registerInterval(
			window.setInterval(() => { void this.backgroundRevalidate(); }, 24 * 60 * 60 * 1000)
		);

		console.debug("Second Brain plugin loaded");

		// 笔记衰减通知
		void this.checkStalePages();
	}

	private async checkStalePages() {
		try {
			const { wikiFolder } = this.settings;
			const lang = this.settings.language;
			const STALE_THRESHOLD = 30;
			const now = Date.now();
			const wikiFiles = this.app.vault.getMarkdownFiles()
				.filter(f => f.path.startsWith(wikiFolder + "/") && !f.path.endsWith("/index.md") && !f.path.endsWith("/log.md") && f.path.includes("concepts/"));
			if (wikiFiles.length === 0) return;

			let staleCount = 0;
			for (const f of wikiFiles) {
				const head = await this.app.vault.cachedRead(f).then(c => c.slice(0, 500));
				const m = head.match(/last_updated:\s*["']?(\d{4}-\d{2}-\d{2})/);
				if (m) {
					const days = Math.floor((now - new Date(m[1]).getTime()) / (1000 * 60 * 60 * 24));
					if (days >= STALE_THRESHOLD) staleCount++;
				}
			}
			if (staleCount > 0) {
				new Notice(t("notice.stalePages", lang, { n: staleCount }));
			}
		} catch (e) {
			console.warn("checkStalePages:", e);
		}
	}

	onunload() {
		if (this.autoCompileTimer) {
			activeWindow.clearTimeout(this.autoCompileTimer);
			this.autoCompileTimer = null;
		}
		clearEmbeddingCache();
	}

	// --- 数据持久化 ---

	private get dataBackupPath(): string {
		return `${this.app.vault.configDir}/plugins/second-brain/data.json.bak`;
	}

	private async loadPluginData(): Promise<Record<string, unknown>> {
		const loaded = await this.loadData();
		if (loaded && typeof loaded === "object" && Object.keys(loaded as Record<string, unknown>).length > 0) {
			return loaded as Record<string, unknown>;
		}
		// data.json 为空或损坏 → 尝试从备份恢复
		try {
			const bak = await this.app.vault.adapter.read(this.dataBackupPath);
			if (bak) {
				const parsed = JSON.parse(bak);
				if (parsed && typeof parsed === "object") {
					console.warn("second-brain: data.json empty/corrupt, restored from backup");
					return parsed as Record<string, unknown>;
				}
			}
		} catch {
			// 无备份文件，使用空对象
		}
		return {};
	}

	private async savePluginData(data: Record<string, unknown>): Promise<void> {
		// 先备份当前 data.json
		try {
			const current = await this.loadData();
			if (current) {
				await this.app.vault.adapter.write(this.dataBackupPath, JSON.stringify(current, null, 2));
			}
		} catch {
			// 首次保存无现有数据，忽略
		}
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
		data._licenseInfo = this.licenseInfo;
		await this.savePluginData(data);
	}

	private async backgroundRevalidate() {
		if (!this.settings.licenseKey) return;
		try {
			const result = await validateLicense(this.settings.licenseKey, this.licenseInfo.instanceId);
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
			// wiki 非空时显示就绪，只有首次（wiki 为空）才显示待编译
			const wikiDir = this.app.vault.getAbstractFileByPath(this.settings.wikiFolder);
			const hasWikiPages = wikiDir instanceof TFolder && wikiDir.children.length > 0;
			if (hasWikiPages) {
				this.statusBarItem.setText(pro ? t("pro.statusReady", lang) : t("sb.ready", lang));
			} else {
				this.statusBarItem.setText(pro ? t("pro.statusPending", lang) : t("sb.pending", lang, { n: count || 0 }));
			}
		}
	}

	async loadSettings() {
		const saved = await this.loadPluginData();
		if (saved.outputLanguage && !saved.language) {
			saved.language = saved.outputLanguage;
			delete saved.outputLanguage;
		}
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		coercePluginSettings(this.settings);

		// 解密 API Key：密文优先，明文兜底。
		// 三种情形：
		//  a) 有密文且能解密 → 用解密值覆盖明文（跨会话正常路径）
		//  b) 有密文但解密失败（跨设备/加密被禁用）→ 保留现有明文 + 告警
		//  c) 无密文 → 使用明文（首次启动 / 加密不可用的设备）
		if (saved._encryptedKeys) {
			const enc = saved._encryptedKeys as Record<string, string>;
			const decrypted = decryptKeys(enc);
			if (decrypted.apiKey) this.settings.apiKey = decrypted.apiKey;
			if (decrypted.embeddingApiKey) this.settings.embeddingApiKey = decrypted.embeddingApiKey;
			if (decrypted.hadFailure) {
				console.warn("main: encrypted keys present but decryption failed on this device; existing plaintext (if any) is preserved");
				new Notice(t("notice.decryptFailed", this.settings.language), 8000);
			}
		}
	}

	async saveSettings() {
		coercePluginSettings(this.settings);
		const data = await this.loadPluginData();
		Object.assign(data, this.settings);
		data._licenseInfo = this.licenseInfo;

		// 加密 API Key：仅在加密成功后才删除明文字段。
		// 任何环节失败（不可用 / 抛异常）都要保留明文，绝不制造"既无密文也无明文"的空洞。
		if (isEncryptionAvailable()) {
			try {
				const enc = encryptKeys(this.settings.apiKey, this.settings.embeddingApiKey);
				// 只有加密结果字段齐全，才移除明文
				const apiKeyOk = !this.settings.apiKey || !!enc.apiKey;
				const embKeyOk = !this.settings.embeddingApiKey || !!enc.embeddingApiKey;
				if (apiKeyOk && embKeyOk) {
					data._encryptedKeys = enc;
					delete data.apiKey;
					delete data.embeddingApiKey;
				} else {
					console.warn("main: partial encryption result, keeping plaintext as fallback");
					delete data._encryptedKeys;
				}
			} catch (e) {
				if (e instanceof SecureStorageError) {
					console.warn("main: encryption failed, keeping plaintext:", e.message);
				} else {
					console.error("main: unexpected error during key encryption:", e);
				}
				// 关键：不删明文，不写入 _encryptedKeys，让下次启动还能读出 key
				delete data._encryptedKeys;
			}
		} else {
			// 加密不可用的设备（如 Obsidian Mobile）：保持明文，但清掉可能从其他设备同步来的、本机无法解密的密文
			delete data._encryptedKeys;
		}
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

		if (this.autoCompileTimer) activeWindow.clearTimeout(this.autoCompileTimer);
		this.updateStatusBar("pending", 1);
		this.autoCompileTimer = activeWindow.setTimeout(() => {
			this.autoCompileTimer = null;
			void this.triggerAutoCompile();
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
				void this.triggerAutoCompile();
			}
		} catch (e) {
			console.warn("main:", e);
		}
	}

	private async triggerAutoCompile() {
		if (this.compileMutex.locked) return;
		if (!this.settings.apiKey) return;

		this.updateStatusBar("compiling");
		try {
			const result = await this.runWithCompileLock(() =>
				runCompile(this.app, this.settings, undefined, false, this),
			);
			const total = result.conceptsCount + result.entitiesCount + result.sourcesCount;
			if (!result.reused) {
				new Notice(t("notice.autoDone", this.settings.language, { n: total }));
			}
		} catch (e: unknown) {
			console.error("Auto compile failed:", (e instanceof Error ? e.message : String(e)));
		} finally {
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
			void workspace.revealLeaf(leaf);
		}
	}

	compileCurrentFile(view: MarkdownView) {
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

		const btnRow = modal.contentEl.createDiv({ cls: "sb-flex-row-end" });

		const cancelBtn = btnRow.createEl("button", { text: t("set.cancel", lang) });
		cancelBtn.addEventListener("click", () => modal.close());

		const confirmBtn = btnRow.createEl("button", { text: t("compile.start", lang), cls: "mod-cta" });
		confirmBtn.addEventListener("click", () => {
			modal.close();
			new Notice(t("notice.compiling", lang, { path: file.path }));
			void (async () => {
			try {
				const content = await this.app.vault.read(file);
				const targetFile = { path: file.path, content };
				const result = await this.runWithCompileLock(() =>
					quickIngest(this.app, this.settings, targetFile),
				);
				new Notice(t("notice.compileDone", lang, { n: result.generated.length }));
			} catch (e: unknown) {
				new Notice(t("notice.compileFail", lang, { msg: describeLLMFailure(lang, e) }));
			}
			})();
		});
		modal.open();
	}
}

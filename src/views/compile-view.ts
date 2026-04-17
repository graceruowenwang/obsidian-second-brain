// 编译面板 — 右侧栏 View，显示编译进度和日志

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { runCompile } from "../core/compile";
import { readRawFiles } from "../core/file-utils";
import type { SecondBrainPlugin, ProgressEvent } from "../types";
import { t } from "../core/i18n";

export const VIEW_TYPE_COMPILE = "second-brain-compile";

export class CompileView extends ItemView {
	plugin: SecondBrainPlugin;
	private logEl: HTMLElement;
	private progressFill: HTMLElement;
	private progressLabel: HTMLElement;
	private compileBtn: HTMLButtonElement;
	private statusEl: HTMLElement;
	private compiling = false;
	private abortController: AbortController | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE_COMPILE; }
	getDisplayText() { return t("compile.start", this.plugin.settings.language); }
	getIcon() { return "zap"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.classList.add("second-brain-compile");
		const lang = this.plugin.settings.language;

		// 按钮
		const btnRow = container.createDiv({ cls: "sb-btn-row" });
		this.compileBtn = btnRow.createEl("button", { text: t("compile.start", lang), cls: "mod-cta" });
		this.compileBtn.addEventListener("click", () => this.startCompile());

		const forceBtn = btnRow.createEl("button", { text: t("compile.force", lang) });
		forceBtn.addEventListener("click", () => this.startCompile(true));

		// 状态
		this.statusEl = container.createDiv({ cls: "sb-status" });

		// 进度条
		const progressWrap = container.createDiv({ cls: "sb-progress-wrap" });
		this.progressLabel = progressWrap.createDiv({ cls: "sb-progress-label" });
		const bar = progressWrap.createDiv({ cls: "sb-progress-bar" });
		this.progressFill = bar.createDiv({ cls: "sb-progress-fill" });

		// 日志
		this.logEl = container.createDiv({ cls: "sb-log" });
		this.addLog(t("compile.clickToStart", lang), "");

		// 加载 raw 文件列表
		this.loadRawFileList(container);
	}

	private async loadRawFileList(container: HTMLElement) {
		const { rawFolder } = this.plugin.settings;
		const lang = this.plugin.settings.language;
		const files = await readRawFiles(this.app, rawFolder);
		const userList = files.filter(f => !f.path.includes("_usage"));
		if (userList.length > 0) {
			this.addLog(t("compile.filesFound", lang, { folder: rawFolder, n: userList.length }), "ok");
		} else {
			this.addLog(t("compile.folderEmpty", lang, { folder: rawFolder }), "err");
		}
	}

	private cancelCompile() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
	}

	private async startCompile(force = false) {
		if (this.compiling) {
			this.cancelCompile();
			return;
		}
		const settings = this.plugin.settings;
		const lang = settings.language;
		if (!settings.apiKey) {
			new Notice(t("notice.noApiKey", lang));
			return;
		}

		this.compiling = true;
		this.abortController = new AbortController();
		this.compileBtn.textContent = t("compile.compiling", lang);
		this.logEl.empty();
		this.progressFill.style.width = "0%";

		const onProgress = (e: ProgressEvent) => {
			this.progressFill.style.width = `${e.percent}%`;
			this.progressLabel.textContent = t("compile.progress", lang, { step: e.stepName, detail: e.detail, pct: e.percent });
		};

		try {
			const result = await runCompile(this.app, settings, onProgress, force, undefined, this.abortController.signal);
			this.addLog(t("compile.done", lang, { c: result.conceptsCount, e: result.entitiesCount, s: result.sourcesCount }), "ok");
			if (result.reused) this.addLog(t("compile.noChange", lang), "");
			if (result.errors.length > 0) {
				this.addLog(t("compile.errors", lang, { n: result.errors.length }), "err");
				for (const e of result.errors) this.addLog(t("compile.errorDetail", lang, { name: e.name, error: e.error }), "err");
			}
			new Notice(t("compile.complete", lang));
		} catch (e: any) {
			if (e.message === "编译已取消") {
				this.addLog(t("compile.compiling", lang) + " — 已取消", "");
			} else {
				this.addLog(t("compile.fail", lang, { msg: e.message }), "err");
				new Notice(t("compile.fail", lang, { msg: e.message }));
			}
		} finally {
			this.compiling = false;
			this.abortController = null;
			this.compileBtn.disabled = false;
			this.compileBtn.textContent = t("compile.start", lang);
		}
	}

	addLog(text: string, cls: string) {
		const line = this.logEl.createDiv({ cls: `sb-log-line ${cls}`, text });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	async onClose() {
		this.cancelCompile();
	}
}

// 编译面板 -- 右侧栏 View，显示编译进度和日志

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { runCompile } from "../core/compile";
import { readRawFiles } from "../core/file-utils";
import type { SecondBrainPlugin, ProgressEvent } from "../types";
import { t } from "../core/i18n";
import { isPro, getCompileTrialLicense } from "../core/license";

export const VIEW_TYPE_COMPILE = "second-brain-compile";

function userFriendlyError(error: string, lang: string): string {
	if (error.includes("429")) return t("compile.error.rateLimit", lang);
	if (error.includes("401") || error.includes("403")) return t("compile.error.auth", lang);
	if (error.includes("timeout") || error.includes("ETIMEDOUT")) return t("compile.error.timeout", lang);
	if (error.includes("network") || error.includes("ECONNREFUSED") || error.includes("fetch")) return t("compile.error.network", lang);
	if (error.includes("JSON") || error.includes("json") || error.includes("parse")) return t("compile.error.parseError", lang);
	return t("compile.error.unknown", lang, { msg: error });
}

export class CompileView extends ItemView {
	plugin: SecondBrainPlugin;
	private logEl: HTMLElement;
	private progressFill: HTMLElement;
	private progressLabel: HTMLElement;
	private compileBtn: HTMLButtonElement;
	private cancelBtn: HTMLButtonElement;
	private compiling = false;
	private abortController: AbortController | null = null;
	private compileStartTime = 0;
	private timeEstimateEl: HTMLElement;

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

		this.cancelBtn = btnRow.createEl("button", { text: t("compile.cancel", lang), cls: "sb-cancel-btn" });
		this.cancelBtn.style.display = "none";
		this.cancelBtn.addEventListener("click", () => this.cancelCompile());

		// 状态
		container.createDiv({ cls: "sb-status" });

		// 进度条
		const progressWrap = container.createDiv({ cls: "sb-progress-wrap" });
		this.progressLabel = progressWrap.createDiv({ cls: "sb-progress-label" });
		const bar = progressWrap.createDiv({ cls: "sb-progress-bar" });
		this.progressFill = bar.createDiv({ cls: "sb-progress-fill" });

		// 时间预估
		this.timeEstimateEl = progressWrap.createDiv({ cls: "sb-time-estimate" });
		this.timeEstimateEl.style.display = "none";

		// 日志
		this.logEl = container.createDiv({ cls: "sb-log" });
		this.addLog(t("compile.clickToStart", lang), "");

		// 加载 raw 文件列表
		this.loadRawFileList();
	}

	private async loadRawFileList() {
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
		this.compileStartTime = Date.now();
		this.abortController = new AbortController();
		this.compileBtn.textContent = t("compile.compiling", lang);
		this.cancelBtn.style.display = "";
		this.logEl.empty();
		this.progressFill.style.width = "0%";
		this.timeEstimateEl.style.display = "none";

		// 移除之前的编译摘要
		const oldSummary = this.logEl.parentElement?.querySelector(".sb-compile-summary");
		if (oldSummary) oldSummary.remove();

		const onProgress = (e: ProgressEvent) => {
			this.progressFill.style.width = `${e.percent}%`;
			this.progressLabel.textContent = t("compile.progress", lang, { step: e.stepName, detail: e.detail, pct: e.percent });

			// 时间预估：进度超过 20% 时显示
			if (e.percent > 20) {
				const elapsed = Math.round((Date.now() - this.compileStartTime) / 1000);
				const remain = Math.round(elapsed * (100 - e.percent) / e.percent);
				this.timeEstimateEl.textContent = t("compile.estimate", lang, { elapsed, remain });
				this.timeEstimateEl.style.display = "";
			}
		};

		let errorCount = 0;

		try {
			const result = await runCompile(this.app, settings, onProgress, force, undefined, this.abortController.signal);
			this.addLog(t("compile.done", lang, { c: result.conceptsCount, e: result.entitiesCount, s: result.sourcesCount }), "ok");
			if (result.reused) this.addLog(t("compile.noChange", lang), "");

			// 编译报告 (Phase 3a)
			if (result.report) {
				const report = result.report;
				if (report.newConcepts.length > 0) {
					this.addLog(t("compile.report.new", lang, { n: report.newConcepts.length }), "ok");
					for (const c of report.newConcepts.slice(0, 10)) {
						this.addLog(`  + ${c.title}${c.sourceFile ? ` (from ${c.sourceFile.split("/").pop()})` : ""}`, "");
					}
				}
				if (report.modifiedConcepts.length > 0) {
					this.addLog(t("compile.report.modified", lang, { n: report.modifiedConcepts.length }), "");
					for (const c of report.modifiedConcepts.slice(0, 5)) {
						this.addLog(`  ~ ${c.title}: ${c.changeSummary}`, "");
					}
				}
				if (report.deletedConcepts.length > 0) {
					this.addLog(t("compile.report.deleted", lang, { n: report.deletedConcepts.length }), "warn");
				}
				if (report.protectedPages > 0) {
					this.addLog(t("compile.report.protected", lang, { n: report.protectedPages }), "");
				}
				if (report.validationIssues.length > 0) {
					this.addLog(t("compile.report.validationWarning", lang, { n: report.validationIssues.length }), "warn");
				}
			}

			// 变更影响 (Phase 5)
			if (result.changeImpact && result.changeImpact.length > 0) {
				this.addLog(t("compile.impact.title", lang), "");
				for (const imp of result.changeImpact.slice(0, 8)) {
					const fileName = imp.rawFile.split("/").pop() || imp.rawFile;
					const pageNames = imp.affectedPages.map(p => `[[${p.name}]]`).join(", ");
					this.addLog(`  ${fileName} -> ${pageNames}`, "");
				}
			}

			if (result.errors.length > 0) {
				errorCount = result.errors.length;
				this.addLog(t("compile.errors", lang, { n: result.errors.length }), "err");
				for (const e of result.errors) {
					this.addLog(t("compile.errorDetail", lang, { name: e.name, error: userFriendlyError(e.error, lang) }), "err");
				}
			}

			// 编译摘要
			const elapsed = Math.round((Date.now() - this.compileStartTime) / 1000);
			this.renderCompileSummary(elapsed, errorCount, force);

			// 首次编译成功 → 触发 3 天 Pro 试用
			if (!isPro(this.plugin.licenseInfo) && !this.plugin.settings.licenseKey) {
				this.plugin.licenseInfo = getCompileTrialLicense();
				await this.plugin.saveLicenseInfo();
				new Notice(t("pro.trialStarted", lang));
			}

			new Notice(t("compile.complete", lang));
		} catch (e: unknown) {
			if ((e instanceof Error ? e.message : String(e)) === "编译已取消") {
				this.addLog(t("compile.compiling", lang) + " -- 已取消", "");
			} else {
				const friendlyMsg = userFriendlyError((e instanceof Error ? e.message : String(e)) || String(e), lang);
				this.addLog(t("compile.fail", lang, { msg: friendlyMsg }), "err");
				new Notice(t("compile.fail", lang, { msg: friendlyMsg }));
			}
		} finally {
			this.compiling = false;
			this.abortController = null;
			this.compileBtn.disabled = false;
			this.compileBtn.textContent = t("compile.start", lang);
			this.cancelBtn.style.display = "none";
			this.timeEstimateEl.style.display = "none";
		}
	}

	private renderCompileSummary(elapsedSec: number, errorCount: number, force: boolean) {
		const lang = this.plugin.settings.language;
		// 移除旧摘要
		const old = this.logEl.parentElement?.querySelector(".sb-compile-summary");
		if (old) old.remove();

		const summary = this.logEl.parentElement!.createDiv({ cls: "sb-compile-summary" });
		const header = summary.createDiv({ cls: "sb-compile-summary-header" });
		header.createEl("span", { text: t("compile.summaryTitle", lang) });
		const stats = summary.createDiv({ cls: "sb-compile-summary-stats" });
		stats.createEl("span", { text: t("compile.summaryTime", lang, { t: elapsedSec }) });
		if (errorCount > 0) {
			stats.createEl("span", { text: t("compile.summaryFailed", lang, { n: errorCount }) });
			const retryBtn = summary.createEl("button", { text: t("compile.retryFailed", lang), cls: "sb-retry-btn" });
			retryBtn.addEventListener("click", () => {
				summary.remove();
				this.startCompile(force);
			});
		}
		// 插入到 logEl 之前
		this.logEl.parentElement!.insertBefore(summary, this.logEl);
	}

	addLog(text: string, cls: string) {
		this.logEl.createDiv({ cls: `sb-log-line ${cls}`, text });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	async onClose() {
		this.cancelCompile();
	}
}

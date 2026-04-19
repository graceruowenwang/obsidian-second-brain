// 编译面板 -- 右侧栏 View，显示编译进度和日志

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { runCompile } from "../core/compile";
import { readRawFiles } from "../core/file-utils";
import type { SecondBrainPlugin, ProgressEvent, CompileResult, CompileCache, CompileHistoryEntry } from "../types";
import { t } from "../core/i18n";
import { isPro, getCompileTrialLicense } from "../core/license";
import { getSuccessRate, getAvgDurationSec } from "../core/usage-stats";

export const VIEW_TYPE_COMPILE = "second-brain-compile";

function userFriendlyError(error: string, lang: string): string {
	if (error.includes("429")) return t("compile.error.rateLimit", lang);
	if (error.includes("401") || error.includes("403")) return t("compile.error.auth", lang);
	if (error.includes("timeout") || error.includes("ETIMEDOUT")) return t("compile.error.timeout", lang);
	if (error.includes("network") || error.includes("ECONNREFUSED") || error.includes("fetch")) return t("compile.error.network", lang);
	if (error.includes("JSON") || error.includes("json") || error.includes("parse")) return t("compile.error.parseError", lang);
	if (error.includes("empty") || error.includes("为空")) return t("compile.error.rawEmpty", lang);
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
	private stageIndicator: HTMLElement;
	private currentFileEl: HTMLElement;

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

		// Issue #8: stage indicator
		this.stageIndicator = progressWrap.createDiv({ cls: "sb-compile-stages" });
		const stages = [
			{ key: "reading", color: "#3b82f6" },
			{ key: "analyzing", color: "#eab308" },
			{ key: "generating", color: "#22c55e" },
			{ key: "writing", color: "#8b5cf6" },
		];
		for (const s of stages) {
			const dot = this.stageIndicator.createDiv({ cls: "sb-compile-stage-dot" });
			dot.createEl("span", { cls: "sb-compile-stage-icon", attr: { style: `background:${s.color}` } });
			dot.createEl("span", { text: t(`compile.stage.${s.key}`, lang), cls: "sb-compile-stage-label" });
		}

		// Current file label
		this.currentFileEl = progressWrap.createDiv({ cls: "sb-compile-current-file" });
		this.currentFileEl.style.display = "none";

		// 时间预估
		this.timeEstimateEl = progressWrap.createDiv({ cls: "sb-time-estimate" });
		this.timeEstimateEl.style.display = "none";

		// 日志
		this.logEl = container.createDiv({ cls: "sb-log" });
		this.addLog(t("compile.clickToStart", lang), "");

		// 加载 raw 文件列表
		this.loadRawFileList();
		// 使用统计
		this.renderStats();
		// Compile history
		this.renderHistory();
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

			// Issue #8: color progress bar by stage
			const stageColors: Record<string, string> = {
				"reading": "#3b82f6", "analyzing": "#eab308",
				"generating": "#22c55e", "writing": "#8b5cf6",
			};
			const color = stageColors[e.stepName.toLowerCase()] ?? "var(--interactive-accent)";
			this.progressFill.style.background = color;

			// Highlight active stage dot
			this.stageIndicator.querySelectorAll(".sb-compile-stage-dot").forEach((dot, i) => {
				(dot as HTMLElement).classList.toggle("sb-compile-stage-active", e.step === i + 1);
			});

			// Show current file
			if (e.detail) {
				this.currentFileEl.textContent = e.detail;
				this.currentFileEl.style.display = "";
			}

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
			const result = await runCompile(this.app, settings, onProgress, force, this.plugin, this.abortController.signal);
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
			this.renderCompileSummary(elapsed, errorCount, force, result);

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
			if (!this.compileBtn) return;
			this.compiling = false;
			this.abortController = null;
			this.compileBtn.disabled = false;
			this.compileBtn.textContent = t("compile.start", lang);
			this.cancelBtn.style.display = "none";
			this.timeEstimateEl.style.display = "none";
		}
	}

	private renderCompileSummary(elapsedSec: number, errorCount: number, force: boolean, result?: CompileResult) {
		const lang = this.plugin.settings.language;
		// 移除旧摘要
		const old = this.logEl.parentElement?.querySelector(".sb-compile-summary");
		if (old) old.remove();

		const summary = this.logEl.parentElement!.createDiv({ cls: "sb-compile-summary" });
		const header = summary.createDiv({ cls: "sb-compile-summary-header" });
		header.createEl("span", { text: t("compile.summaryTitle", lang) });

		// Stats badge row
		const badges = summary.createDiv({ cls: "sb-compile-summary-badges" });
		const newCount = result?.report?.newConcepts.length ?? 0;
		const modCount = result?.report?.modifiedConcepts.length ?? 0;
		const relCount = result?.changeImpact?.length ?? 0;
		const totalPages = result ? result.conceptsCount + result.entitiesCount + result.sourcesCount : 0;
		const statEntries = [
			{ value: newCount, labelKey: "compile.statsNew", cls: "sb-stat-new" },
			{ value: modCount, labelKey: "compile.statsModified", cls: "sb-stat-modified" },
			{ value: relCount, labelKey: "compile.statsRelations", cls: "sb-stat-relations" },
			{ value: totalPages, labelKey: "compile.statsTotal", cls: "sb-stat-total" },
		];
		for (const s of statEntries) {
			const badge = badges.createDiv({ cls: `sb-compile-stat-badge ${s.cls}` });
			badge.createEl("span", { text: String(s.value), cls: "sb-compile-stat-num" });
			badge.createEl("span", { text: t(s.labelKey, lang), cls: "sb-compile-stat-label" });
		}

		// Time
		const timeEl = summary.createDiv({ cls: "sb-compile-summary-time" });
		timeEl.createEl("span", { text: t("compile.summaryTime", lang, { t: elapsedSec }) });

		if (errorCount > 0) {
			const failEl = summary.createDiv({ cls: "sb-compile-summary-fail" });
			failEl.createEl("span", { text: t("compile.summaryFailed", lang, { n: errorCount }) });
			const retryBtn = failEl.createEl("button", { text: t("compile.retryFailed", lang), cls: "sb-retry-btn" });
			retryBtn.addEventListener("click", () => {
				summary.remove();
				this.startCompile(force);
			});
		}

			// Next step guidance
			if (errorCount === 0 && totalPages > 0) {
				const guideEl = summary.createDiv({ cls: "sb-compile-guide" });
				const viewBtn = guideEl.createEl("button", { text: t("compile.viewWiki", lang), cls: "sb-compile-guide-btn mod-cta" });
				viewBtn.addEventListener("click", () => {
					this.plugin.activateView("second-brain-wiki");
				});
			}

		// 插入到 logEl 之前
		this.logEl.parentElement!.insertBefore(summary, this.logEl);
	}


	private async renderHistory() {
		const lang = this.plugin.settings.language;
		const container = this.containerEl.children[1] as HTMLElement;

		const existing = container.querySelector('.sb-compile-history');
		if (existing) existing.remove();

		const cache = await (this.plugin as any).loadData() as CompileCache | null;
		const history = cache?.compileHistory;
		if (!history || history.length === 0) return;

		const historyEl = container.createDiv({ cls: "sb-compile-history" });
		historyEl.createEl("h4", { text: t("compile.historyTitle", lang), cls: "sb-compile-history-title" });

		for (const entry of history.slice(0, 10)) {
			const row = historyEl.createDiv({ cls: "sb-history-entry" });

			const tagMap: Record<string, string> = { full: "compile.historyFull", incremental: "compile.historyIncremental", single: "compile.historySingle" };
			const tag = row.createEl("span", { text: t(tagMap[entry.action] || "compile.historyIncremental", lang), cls: "sb-history-tag sb-history-tag-" + entry.action });

			const dateStr = new Date(entry.date).toLocaleDateString();
			row.createEl("span", { text: dateStr, cls: "sb-history-date" });

			const changes: string[] = [];
			if (entry.added.length > 0) changes.push("+" + entry.added.length);
			if (entry.modified.length > 0) changes.push("~" + entry.modified.length);
			if (entry.removed.length > 0) changes.push("-" + entry.removed.length);
			row.createEl("span", { text: changes.join(" "), cls: "sb-history-changes" });

			const sec = Math.round(entry.durationMs / 1000);
			row.createEl("span", { text: t("compile.historyDuration", lang, { t: sec }), cls: "sb-history-duration" });

			if (entry.added.length > 0 || entry.modified.length > 0) {
				const detailBtn = row.createEl("span", { text: "...", cls: "sb-history-detail-toggle" });
				const detailEl = historyEl.createDiv({ cls: "sb-history-detail" });
				detailEl.style.display = "none";
				const names = [...entry.added.map(n => "+ " + n), ...entry.modified.map(n => "~ " + n), ...entry.removed.map(n => "- " + n)];
				for (const name of names) {
					detailEl.createEl("div", { text: name, cls: "sb-history-detail-item" });
				}
				detailBtn.addEventListener("click", () => {
					const open = detailEl.style.display !== "none";
					detailEl.style.display = open ? "none" : "";
					detailBtn.textContent = open ? "..." : "▲";
				});
			}
		}

		this.logEl.parentElement?.insertBefore(historyEl, this.logEl);
	}

	addLog(text: string, cls: string) {
		this.logEl.createDiv({ cls: `sb-log-line ${cls}`, text });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	private async renderStats() {
		const lang = this.plugin.settings.language;
		const container = this.containerEl.children[1] as HTMLElement;

		const existing = container.querySelector('.sb-usage-stats');
		if (existing) existing.remove();

		const cache = await (this.plugin as any).loadData() as CompileCache | null;
		const stats = cache?.usageStats;
		if (!stats || stats.totalCompiles === 0) return;

		const statsEl = container.createDiv({ cls: "sb-usage-stats" });
		statsEl.createEl("h4", { text: t("stats.title", lang), cls: "sb-stats-title" });

		const grid = statsEl.createDiv({ cls: "sb-stats-grid" });
		const entries = [
			{ value: String(stats.totalCompiles), label: t("stats.totalCompiles", lang) },
			{ value: getSuccessRate(stats) + "%", label: t("stats.successRate", lang) },
			{ value: getAvgDurationSec(stats) + "s", label: t("stats.avgDuration", lang) },
			{ value: String(stats.totalConceptsGenerated), label: t("stats.totalConcepts", lang) },
			{ value: String(stats.weeklyCompiles), label: t("stats.weeklyCompiles", lang) },
		];

		for (const e of entries) {
			const cell = grid.createDiv({ cls: "sb-stat-cell" });
			cell.createEl("span", { text: e.value, cls: "sb-stat-value" });
			cell.createEl("span", { text: e.label, cls: "sb-stat-label" });
		}

		this.logEl.parentElement?.insertBefore(statsEl, this.logEl);
	}

	async onClose() {
		this.cancelCompile();
	}
}

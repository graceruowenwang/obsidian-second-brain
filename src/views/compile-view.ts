// 编译面板 -- 右侧栏 View，显示编译进度和日志

import { ItemView, WorkspaceLeaf, Notice, setTooltip, TFolder } from "obsidian";
import { runCompile } from "../core/compile";
import { readRawFiles } from "../core/file-utils";
import type { SecondBrainPlugin, ProgressEvent, CompileResult, CompileCache } from "../types";
import { emptyStats, getSuccessRate, getAvgDurationSec } from "../core/usage-stats";
import { t } from "../core/i18n";
import { isPro, getCompileTrialLicense } from "../core/license";
import { friendlyCompilePageError, describeLLMFailure } from "../core/llm-user-message";
import type { LLMErrorCode } from "../core/llm";

export const VIEW_TYPE_COMPILE = "second-brain-compile";

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
	private dataVaultMount!: HTMLElement;
	private dataStatsMount!: HTMLElement;
	private dataHistoryMount!: HTMLElement;

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

		// 操作栏
		const btnRow = container.createDiv({ cls: "sb-compile-toolbar sb-btn-row" });
		this.compileBtn = btnRow.createEl("button", { text: t("compile.start", lang), cls: "mod-cta sb-compile-btn-primary" });
		setTooltip(this.compileBtn, t("compile.tooltip.start", lang));
		this.compileBtn.addEventListener("click", () => this.startCompile());

		const forceBtn = btnRow.createEl("button", { text: t("compile.force", lang), cls: "sb-compile-btn-secondary" });
		setTooltip(forceBtn, t("compile.tooltip.force", lang));
		forceBtn.addEventListener("click", () => this.startCompile(true));

		const organizeBtn = btnRow.createEl("button", { text: t("compile.organizeRaw", lang), cls: "sb-compile-btn-secondary" });
		setTooltip(organizeBtn, t("compile.tooltip.organizeRaw", lang));
		organizeBtn.addEventListener("click", async () => {
			organizeBtn.disabled = true;
			try {
				await this.plugin.organizeRawMaterials();
				await this.loadRawFileList();
			} finally {
				organizeBtn.disabled = false;
			}
		});

		this.cancelBtn = btnRow.createEl("button", { text: t("compile.cancel", lang), cls: "sb-cancel-btn" });
		setTooltip(this.cancelBtn, t("compile.tooltip.cancel", lang));
		this.cancelBtn.style.display = "none";
		this.cancelBtn.addEventListener("click", () => this.cancelCompile());

		// 进度区（卡片）
		const progressCard = container.createDiv({ cls: "sb-compile-progress-card" });
		setTooltip(progressCard, t("compile.tooltip.progress", lang));
		const progressWrap = progressCard.createDiv({ cls: "sb-progress-wrap" });
		this.progressLabel = progressWrap.createDiv({ cls: "sb-progress-label" });
		const bar = progressWrap.createDiv({ cls: "sb-progress-bar" });
		this.progressFill = bar.createDiv({ cls: "sb-progress-fill" });

		// 阶段指示（单色系，由 CSS 区分状态）
		this.stageIndicator = progressWrap.createDiv({ cls: "sb-compile-stages" });
		const stageKeys = ["reading", "analyzing", "generating", "writing"] as const;
		for (const key of stageKeys) {
			const dot = this.stageIndicator.createDiv({ cls: "sb-compile-stage-dot" });
			setTooltip(dot, t(`compile.tooltip.stage.${key}`, lang));
			dot.createEl("span", { cls: "sb-compile-stage-icon" });
			dot.createEl("span", { text: t(`compile.stage.${key}`, lang), cls: "sb-compile-stage-label" });
		}

		// Current file label
		this.currentFileEl = progressWrap.createDiv({ cls: "sb-compile-current-file" });
		this.currentFileEl.style.display = "none";

		// 时间预估
		this.timeEstimateEl = progressWrap.createDiv({ cls: "sb-time-estimate" });
		this.timeEstimateEl.style.display = "none";

		// 数据面板：素材目录 + 使用统计 + 编译历史（独立于日志区）
		const dataPanel = container.createDiv({ cls: "sb-compile-data-panel" });
		const panelHead = dataPanel.createDiv({ cls: "sb-compile-data-panel-header" });
		panelHead.createEl("span", { cls: "sb-compile-data-panel-title", text: t("compile.dataPanelTitle", lang) });

		this.dataVaultMount = dataPanel.createDiv({ cls: "sb-compile-data-vault-wrap" });

		const statsBlock = dataPanel.createDiv({ cls: "sb-compile-data-block" });
		const statsHeading = statsBlock.createEl("h3", { cls: "sb-compile-data-block-title", text: t("stats.title", lang) });
		setTooltip(statsHeading, t("compile.tooltip.usageStats", lang));
		this.dataStatsMount = statsBlock.createDiv({ cls: "sb-compile-data-block-body" });

		this.dataHistoryMount = dataPanel.createDiv({ cls: "sb-compile-data-history-wrap" });

		// 日志
		this.logEl = container.createDiv({ cls: "sb-log" });
		this.addLog(t("compile.clickToStart", lang), "");

		await this.loadRawFileList();
		await this.renderStats();
		await this.renderHistory();
	}

	/** 素材目录是否存在、其中可用文件数（不含 _usage） */
	private async readRawSummary(): Promise<{ folder: string; count: number; exists: boolean }> {
		const rawFolder = this.plugin.settings.rawFolder;
		const folder = this.app.vault.getAbstractFileByPath(rawFolder);
		const exists = folder instanceof TFolder;
		if (!exists) return { folder: rawFolder, count: 0, exists: false };
		const files = await readRawFiles(this.app, rawFolder);
		const userList = files.filter(f => !f.path.includes("_usage"));
		return { folder: rawFolder, count: userList.length, exists: true };
	}

	private renderVaultStrip(summary: { folder: string; count: number; exists: boolean }, lang: string): void {
		this.dataVaultMount.empty();
		const row = this.dataVaultMount.createDiv({ cls: "sb-compile-vault-row" });
		row.createEl("span", { cls: "sb-compile-vault-caption", text: t("compile.dataVaultCaption", lang) });
		const pathWrap = row.createDiv({ cls: "sb-compile-vault-path-wrap" });
		pathWrap.createEl("code", { text: summary.folder, cls: "sb-compile-vault-path" });
		const badge = row.createDiv({ cls: "sb-compile-vault-badge" });
		if (!summary.exists) {
			badge.classList.add("sb-compile-vault-badge--warn");
			badge.textContent = t("compile.dataVaultMissing", lang);
		} else if (summary.count === 0) {
			badge.classList.add("sb-compile-vault-badge--muted");
			badge.textContent = t("compile.dataVaultEmpty", lang);
		} else {
			badge.classList.add("sb-compile-vault-badge--ok");
			badge.textContent = t("compile.dataVaultFiles", lang, { n: String(summary.count) });
		}
	}

	private async loadRawFileList() {
		const lang = this.plugin.settings.language;
		const s = await this.readRawSummary();
		this.renderVaultStrip(s, lang);
		if (s.count > 0) {
			this.addLog(t("compile.filesFound", lang, { folder: s.folder, n: s.count }), "ok");
		} else {
			this.addLog(t("compile.folderEmpty", lang, { folder: s.folder }), "err");
		}
	}

	/** 仅刷新顶栏素材摘要（不发日志）— 编译结束或整理 raw 后调用 */
	private async refreshVaultStripOnly(): Promise<void> {
		const lang = this.plugin.settings.language;
		const s = await this.readRawSummary();
		this.renderVaultStrip(s, lang);
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
		setTooltip(this.compileBtn, t("compile.tooltip.compilingPrimary", lang));
		this.cancelBtn.style.display = "";
		this.logEl.empty();
		this.progressFill.style.width = "0%";
		this.progressFill.style.background = "";
		this.timeEstimateEl.style.display = "none";
		this.resetStageDots();

		// 移除之前的编译摘要
		const oldSummary = this.logEl.parentElement?.querySelector(".sb-compile-summary");
		if (oldSummary) oldSummary.remove();

		const onProgress = (e: ProgressEvent) => {
			this.progressFill.style.width = `${e.percent}%`;
			this.progressLabel.textContent = t("compile.progress", lang, { step: e.stepName, detail: e.detail, pct: e.percent });

			// 阶段指示：已完成 / 当前 / 未开始
			this.stageIndicator.querySelectorAll(".sb-compile-stage-dot").forEach((dot, i) => {
				const el = dot as HTMLElement;
				const idx = i + 1;
				el.classList.toggle("sb-compile-stage-active", e.step === idx);
				el.classList.toggle("sb-compile-stage-done", e.step > idx);
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
			const result = await this.plugin.runWithCompileLock(() =>
				runCompile(this.app, settings, onProgress, force, this.plugin, this.abortController!.signal),
			);
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

			// P2: 缺口检测报告
			if (result.stubsGenerated && result.stubsGenerated > 0) {
				this.addLog(`缺口检测: 发现 ${result.gapDetected} 个知识缺口，生成 ${result.stubsGenerated} 个待补充页面`, "ok");
			}
			// P1: 智能补链报告
			if (result.linksAdded && result.linksAdded > 0) {
				this.addLog(`智能补链: 新增 ${result.linksAdded} 条语义关联链接`, "ok");
			}

			if (result.errors.length > 0) {
				errorCount = result.errors.length;
				this.addLog(t("compile.errors", lang, { n: result.errors.length }), "err");
				for (const e of result.errors) {
					this.addLog(t("compile.errorDetail", lang, {
						name: e.name,
						error: friendlyCompilePageError(lang, e.error, e.code as LLMErrorCode | undefined),
					}), "err");
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

			await this.refreshVaultStripOnly();
			await this.renderStats();
			await this.renderHistory();

			new Notice(t("compile.complete", lang));
		} catch (e: unknown) {
			if ((e instanceof Error ? e.message : String(e)) === "编译已取消") {
				this.addLog(t("compile.compiling", lang) + " -- 已取消", "");
			} else {
				const friendlyMsg = describeLLMFailure(lang, e);
				this.addLog(t("compile.fail", lang, { msg: friendlyMsg }), "err");
				new Notice(t("compile.fail", lang, { msg: friendlyMsg }));
			}
		} finally {
			if (!this.compileBtn) return;
			this.compiling = false;
			this.abortController = null;
			this.compileBtn.disabled = false;
			this.compileBtn.textContent = t("compile.start", lang);
			setTooltip(this.compileBtn, t("compile.tooltip.start", lang));
			this.cancelBtn.style.display = "none";
			this.timeEstimateEl.style.display = "none";
			this.progressFill.style.background = "";
			this.resetStageDots();
		}
	}

	private resetStageDots() {
		this.stageIndicator?.querySelectorAll(".sb-compile-stage-dot").forEach((dot) => {
			dot.classList.remove("sb-compile-stage-active", "sb-compile-stage-done");
		});
	}

	private renderCompileSummary(elapsedSec: number, errorCount: number, force: boolean, result?: CompileResult) {
		const lang = this.plugin.settings.language;
		// 移除旧摘要
		const old = this.logEl.parentElement?.querySelector(".sb-compile-summary");
		if (old) old.remove();

		const summary = this.logEl.parentElement!.createDiv({
			cls: "sb-compile-summary" + (errorCount > 0 ? " sb-compile-summary--errors" : ""),
		});
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
		const statTipKeys: Record<string, string> = {
			"compile.statsNew": "compile.tooltip.statNew",
			"compile.statsModified": "compile.tooltip.statModified",
			"compile.statsRelations": "compile.tooltip.statRelations",
			"compile.statsTotal": "compile.tooltip.statTotal",
		};
		for (const s of statEntries) {
			const badge = badges.createDiv({ cls: `sb-compile-stat-badge ${s.cls}` });
			const tipKey = statTipKeys[s.labelKey];
			if (tipKey) setTooltip(badge, t(tipKey, lang));
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
			setTooltip(retryBtn, t("compile.tooltip.retryFailed", lang));
			retryBtn.addEventListener("click", () => {
				summary.remove();
				this.startCompile(force);
			});
		}

			// Next step guidance
			if (errorCount === 0 && totalPages > 0) {
				const guideEl = summary.createDiv({ cls: "sb-compile-guide" });
				const viewBtn = guideEl.createEl("button", { text: t("compile.viewWiki", lang), cls: "sb-compile-guide-btn mod-cta" });
				setTooltip(viewBtn, t("compile.tooltip.viewWiki", lang));
				viewBtn.addEventListener("click", () => {
					this.plugin.activateView("second-brain-wiki");
				});
			}

		// 插入到 logEl 之前
		this.logEl.parentElement!.insertBefore(summary, this.logEl);
	}


	private async renderHistory() {
		const lang = this.plugin.settings.language;
		this.dataHistoryMount.empty();

		const cache = (await this.plugin.loadData()) as CompileCache | null;
		const history = cache?.compileHistory ?? [];

		const details = this.dataHistoryMount.createEl("details", { cls: "sb-compile-history-details" });
		details.open = true;
		const sum = details.createEl("summary", { cls: "sb-compile-history-summary" });
		sum.createSpan({ cls: "sb-compile-history-summary-label", text: t("compile.historyTitle", lang) });
		if (history.length > 0) {
			sum.createSpan({ cls: "sb-compile-history-summary-count", text: String(Math.min(history.length, 10)) });
		}

		const listWrap = details.createDiv({ cls: "sb-compile-history-list-wrap" });
		if (history.length === 0) {
			listWrap.createDiv({ cls: "sb-compile-history-empty", text: t("compile.historyNoRecords", lang) });
			return;
		}

		for (const entry of history.slice(0, 10)) {
			const row = listWrap.createDiv({ cls: "sb-history-entry" });

			const tagMap: Record<string, string> = { full: "compile.historyFull", incremental: "compile.historyIncremental", single: "compile.historySingle" };
			row.createEl("span", { text: t(tagMap[entry.action] || "compile.historyIncremental", lang), cls: "sb-history-tag sb-history-tag-" + entry.action });

			const dateStr = new Date(entry.date).toLocaleDateString();
			row.createEl("span", { text: dateStr, cls: "sb-history-date" });

			const changes: string[] = [];
			if (entry.added.length > 0) changes.push("+" + entry.added.length);
			if (entry.modified.length > 0) changes.push("~" + entry.modified.length);
			if (entry.removed.length > 0) changes.push("-" + entry.removed.length);
			row.createEl("span", { text: changes.join(" ") || "—", cls: "sb-history-changes" });

			const sec = Math.round(entry.durationMs / 1000);
			row.createEl("span", { text: t("compile.historyDuration", lang, { t: sec }), cls: "sb-history-duration" });

			if (entry.added.length > 0 || entry.modified.length > 0 || entry.removed.length > 0) {
				const detailBtn = row.createEl("span", { text: "···", cls: "sb-history-detail-toggle" });
				setTooltip(detailBtn, t("compile.tooltip.historyDetail", lang));
				const detailEl = listWrap.createDiv({ cls: "sb-history-detail" });
				detailEl.style.display = "none";
				const names = [...entry.added.map(n => "+ " + n), ...entry.modified.map(n => "~ " + n), ...entry.removed.map(n => "- " + n)];
				for (const name of names) {
					detailEl.createEl("div", { text: name, cls: "sb-history-detail-item" });
				}
				detailBtn.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					const open = detailEl.style.display !== "none";
					detailEl.style.display = open ? "none" : "";
					detailBtn.textContent = open ? "···" : "▲";
				});
			}
		}
	}

	addLog(text: string, cls: string) {
		this.logEl.createDiv({ cls: `sb-log-line ${cls}`, text });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	private async renderStats() {
		const lang = this.plugin.settings.language;
		this.dataStatsMount.empty();

		const cache = (await this.plugin.loadData()) as CompileCache | null;
		const raw = cache?.usageStats;
		const stats = raw && raw.totalCompiles > 0 ? raw : emptyStats();
		const hasRealData = !!(raw && raw.totalCompiles > 0);

		const grid = this.dataStatsMount.createDiv({ cls: "sb-stats-grid" });
		const entries = [
			{ value: String(stats.totalCompiles), label: t("stats.totalCompiles", lang) },
			{ value: getSuccessRate(stats) + "%", label: t("stats.successRate", lang) },
			{ value: getAvgDurationSec(stats) + "s", label: t("stats.avgDuration", lang) },
			{ value: String(stats.totalConceptsGenerated), label: t("stats.totalConcepts", lang) },
			{ value: String(stats.weeklyCompiles), label: t("stats.weeklyCompiles", lang) },
		];

		for (const e of entries) {
			const cell = grid.createDiv({ cls: "sb-stat-cell" + (hasRealData ? "" : " sb-stat-cell--placeholder") });
			cell.createEl("span", { text: e.value, cls: "sb-stat-value" });
			cell.createEl("span", { text: e.label, cls: "sb-stat-label" });
		}

		if (!hasRealData) {
			this.dataStatsMount.createEl("p", { cls: "sb-stats-empty-hint", text: t("stats.emptyHint", lang) });
		}
	}

	async onClose() {
		this.cancelCompile();
	}
}

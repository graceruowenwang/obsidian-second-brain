// 编译面板 -- 右侧栏 View，显示编译进度和日志

import { ItemView, WorkspaceLeaf, Notice, TAbstractFile, TFolder } from "obsidian";
import { bindHoverHint } from "../ui/hover-hint";
import { runCompile } from "../core/compile";
import { readRawFiles } from "../core/file-utils";
import type { SecondBrainPlugin, ProgressEvent, CompileResult, CompileCache, CompileHistoryEntry } from "../types";
import { getSuccessRate, getAvgDurationSec } from "../core/usage-stats";
import { t } from "../core/i18n";
import { shouldStartCompileTrial, getCompileTrialLicense } from "../core/license";
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
	private statsSectionEl!: HTMLElement;
	private histSectionEl!: HTMLElement;
	private rawRefreshTimer: number | null = null;
	private estimateTimer: number | null = null;
	private latestProgressPercent = 0;

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE_COMPILE; }
	getDisplayText() { return t("compile.start", this.plugin.settings.language); }
	getIcon() { return "zap"; }

	async onOpen() {
		// 使用 ItemView.contentEl，侧栏里才能参与正确的高度收缩，避免底部日志整块被裁掉
		const container = this.contentEl;
		container.empty();
		container.classList.add("second-brain-compile");
		const lang = this.plugin.settings.language;

		// 操作栏
		const btnRow = container.createDiv({ cls: "sb-compile-toolbar sb-btn-row" });
		this.compileBtn = btnRow.createEl("button", { text: t("compile.start", lang), cls: "mod-cta sb-compile-btn-primary" });
		bindHoverHint(this.compileBtn, t("compile.tooltip.start", lang));
		this.compileBtn.addEventListener("click", () => this.startCompile());

		const forceBtn = btnRow.createEl("button", { text: t("compile.force", lang), cls: "sb-compile-btn-secondary" });
		bindHoverHint(forceBtn, t("compile.tooltip.force", lang));
		forceBtn.addEventListener("click", () => this.startCompile(true));

		const organizeBtn = btnRow.createEl("button", { text: t("compile.organizeRaw", lang), cls: "sb-compile-btn-secondary" });
		bindHoverHint(organizeBtn, t("compile.tooltip.organizeRaw", lang));
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
		bindHoverHint(this.cancelBtn, t("compile.tooltip.cancel", lang));
		this.cancelBtn.style.display = "none";
		this.cancelBtn.addEventListener("click", () => this.cancelCompile());

		// 进度区（卡片）— 提示绑在 progressWrap 上，避免子节点挡住父级导致 hover 不触发
		const progressCard = container.createDiv({ cls: "sb-compile-progress-card" });
		const progressWrap = progressCard.createDiv({ cls: "sb-progress-wrap" });
		bindHoverHint(progressWrap, t("compile.tooltip.progress", lang));
		this.progressLabel = progressWrap.createDiv({ cls: "sb-progress-label" });
		const bar = progressWrap.createDiv({ cls: "sb-progress-bar" });
		this.progressFill = bar.createDiv({ cls: "sb-progress-fill" });

		// 阶段指示（单色系，由 CSS 区分状态）
		this.stageIndicator = progressWrap.createDiv({ cls: "sb-compile-stages" });
		const stageKeys = ["reading", "analyzing", "generating", "writing"] as const;
		for (const key of stageKeys) {
			const dot = this.stageIndicator.createDiv({ cls: "sb-compile-stage-dot" });
			bindHoverHint(dot, t(`compile.tooltip.stage.${key}`, lang));
			dot.createEl("span", { cls: "sb-compile-stage-icon" });
			dot.createEl("span", { text: t(`compile.stage.${key}`, lang), cls: "sb-compile-stage-label" });
		}

		// Current file label
		this.currentFileEl = progressWrap.createDiv({ cls: "sb-compile-current-file" });
		this.currentFileEl.style.display = "none";

		// 时间预估
		this.timeEstimateEl = progressWrap.createDiv({ cls: "sb-time-estimate" });
		this.timeEstimateEl.style.display = "none";

		// 数据面板：分三块白话说明（素材 / 累计统计 / 最近记录）
		const dataPanel = container.createDiv({ cls: "sb-compile-data-panel" });
		const panelHead = dataPanel.createDiv({ cls: "sb-compile-data-panel-header" });
		panelHead.createEl("span", { cls: "sb-compile-data-panel-title", text: t("compile.dataPanelTitle", lang) });
		panelHead.createEl("p", { cls: "sb-compile-data-panel-intro", text: t("compile.dataPanelIntro", lang) });

		this.dataVaultMount = dataPanel.createDiv({ cls: "sb-compile-data-section sb-compile-data-section--raw" });

		this.statsSectionEl = dataPanel.createDiv({ cls: "sb-compile-data-section sb-compile-data-section--stats" });
		this.statsSectionEl.createEl("h3", { cls: "sb-compile-data-section-title", text: t("compile.dataSection2Title", lang) });
		this.statsSectionEl.createEl("p", { cls: "sb-compile-data-section-lead", text: t("compile.dataSection2Lead", lang) });
		const statsHeading = this.statsSectionEl.querySelector(".sb-compile-data-section-title") as HTMLElement;
		bindHoverHint(statsHeading, t("compile.tooltip.usageStats", lang));
		this.dataStatsMount = this.statsSectionEl.createDiv({ cls: "sb-compile-data-section-body" });

		this.histSectionEl = dataPanel.createEl("details", { cls: "sb-compile-data-section sb-compile-data-section--history" });
		const histSummary = this.histSectionEl.createEl("summary", { cls: "sb-compile-data-section-summary" });
		histSummary.createEl("span", { text: t("compile.dataSection3Title", lang), cls: "sb-compile-data-section-title" });
		histSummary.createEl("span", { text: t("compile.dataSection3Lead", lang), cls: "sb-compile-data-section-lead-inline" });
		this.dataHistoryMount = this.histSectionEl.createDiv({ cls: "sb-compile-data-section-body" });

		// 编译摘要 + 日志：同一滚动区，避免摘要被 flex 挤出可视区或裁切
		const lowerScroll = container.createDiv({ cls: "sb-compile-lower-scroll" });
		this.logEl = lowerScroll.createDiv({ cls: "sb-log" });
		this.addLog(t("compile.clickToStart", lang), "");

		await this.loadRawFileList();
		await this.renderStats();
		await this.renderHistory();

		// 监听 raw 目录变化，避免在其他入口导入素材后面板仍显示旧的“空目录”状态。
		this.registerEvent(this.app.vault.on("create", (file) => this.onRawFolderChanged(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.onRawFolderChanged(file)));
		this.registerEvent(this.app.vault.on("rename", (file) => this.onRawFolderChanged(file)));
	}

	private onRawFolderChanged(file: TAbstractFile): void {
		const rawFolder = this.plugin.settings.rawFolder;
		const rawPrefix = `${rawFolder}/`;
		const path = file.path;
		if (path !== rawFolder && !path.startsWith(rawPrefix)) return;
		if (this.rawRefreshTimer != null) window.clearTimeout(this.rawRefreshTimer);
		this.rawRefreshTimer = window.setTimeout(() => {
			this.rawRefreshTimer = null;
			void this.refreshVaultStripOnly();
		}, 120);
	}

	/** 素材目录是否存在、其中可用文件数（不含 _usage） */
	private async readRawSummary(): Promise<{ folder: string; count: number; exists: boolean }> {
		const rawFolder = this.plugin.settings.rawFolder;
		const normalized = rawFolder
			.trim()
			.replace(/\\/g, "/")
			.replace(/^\/+/, "")
			.replace(/\/+/g, "/")
			.replace(/\/+$/, "");
		const folder = this.app.vault.getAbstractFileByPath(normalized) ?? this.app.vault.getAbstractFileByPath(rawFolder);
		const exists = folder instanceof TFolder;
		if (!exists) return { folder: rawFolder, count: 0, exists: false };
		const files = await readRawFiles(this.app, normalized || rawFolder);
		const userList = files.filter(f => !f.path.includes("_usage"));
		return { folder: rawFolder, count: userList.length, exists: true };
	}

	private renderVaultStrip(summary: { folder: string; count: number; exists: boolean }, lang: string): void {
		this.dataVaultMount.empty();
		this.dataVaultMount.createEl("h3", { cls: "sb-compile-data-section-title", text: t("compile.dataSection1Title", lang) });
		this.dataVaultMount.createEl("p", { cls: "sb-compile-data-section-lead", text: t("compile.dataSection1Lead", lang) });
		const status = this.dataVaultMount.createDiv({ cls: "sb-compile-vault-status" });
		if (!summary.exists) {
			status.classList.add("sb-compile-vault-status--warn");
			status.textContent = t("compile.dataVaultStatusMissing", lang, { path: summary.folder });
		} else if (summary.count === 0) {
			status.classList.add("sb-compile-vault-status--muted");
			status.textContent = t("compile.dataVaultStatusEmpty", lang, { path: summary.folder });
		} else {
			status.classList.add("sb-compile-vault-status--ok");
			status.textContent = t("compile.dataVaultStatusOk", lang, { path: summary.folder, n: String(summary.count) });
		}
		this.dataVaultMount.createEl("code", { cls: "sb-compile-vault-path-foot", text: summary.folder });
	}

	private async loadRawFileList() {
		const lang = this.plugin.settings.language;
		const s = await this.readRawSummary();
		this.renderVaultStrip(s, lang);
		if (!s.exists) {
			this.addLog(t("compile.folderMissing", lang, { folder: s.folder }), "err");
		} else if (s.count > 0) {
			this.addLog(t("compile.filesFound", lang, { folder: s.folder, n: s.count }), "ok");
		} else {
			this.addLog(t("compile.folderNoCompilable", lang, { folder: s.folder }), "err");
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
		this.stopEstimateTimer();
	}

	private stopEstimateTimer(): void {
		if (this.estimateTimer != null) {
			window.clearInterval(this.estimateTimer);
			this.estimateTimer = null;
		}
	}

	private elapsedSeconds(): number {
		const ms = Date.now() - this.compileStartTime;
		// 避免 sub-second 编译阶段显示 0s，导致用户误以为计时失效。
		return ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0;
	}

	private updateTimeEstimate(lang: string): void {
		if (this.latestProgressPercent <= 20) {
			this.timeEstimateEl.style.display = "none";
			return;
		}
		const elapsed = this.elapsedSeconds();
		const percent = Math.max(1, Math.min(100, this.latestProgressPercent));
		const remain = percent >= 100 ? 0 : Math.max(1, Math.ceil((elapsed * (100 - percent)) / percent));
		this.timeEstimateEl.textContent = t("compile.estimate", lang, { elapsed, remain });
		this.timeEstimateEl.style.display = "";
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
		this.latestProgressPercent = 0;
		this.abortController = new AbortController();
		this.compileBtn.textContent = t("compile.compiling", lang);
		bindHoverHint(this.compileBtn, t("compile.tooltip.compilingPrimary", lang));
		this.cancelBtn.style.display = "";
		this.logEl.empty();
		this.progressFill.style.width = "0%";
		this.progressFill.style.background = "";
		this.timeEstimateEl.style.display = "none";
		this.stopEstimateTimer();
		this.resetStageDots();

		// 移除之前的编译摘要
		const oldSummary = this.logEl.parentElement?.querySelector(".sb-compile-summary");
		if (oldSummary) oldSummary.remove();

		const onProgress = (e: ProgressEvent) => {
			this.progressFill.style.width = `${e.percent}%`;
			this.progressLabel.textContent = t("compile.progress", lang, { step: e.stepName, detail: e.detail, pct: e.percent });
			this.latestProgressPercent = e.percent;

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

			// 时间预估：进度超过 20% 时显示，并每秒刷新一次避免长阶段卡在旧数值。
			if (e.percent > 20) {
				this.updateTimeEstimate(lang);
				if (this.estimateTimer == null) {
					this.estimateTimer = window.setInterval(() => this.updateTimeEstimate(lang), 1000);
				}
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
			const elapsed = this.elapsedSeconds();
			this.renderCompileSummary(elapsed, errorCount, force, result);

			// 首次编译成功 → 记录完整 Pro 试用起点（公测 BETA_MODE 下门控仍全开，但设置页可显示剩余天数）
			if (shouldStartCompileTrial(this.plugin.licenseInfo, this.plugin.settings.licenseKey)) {
				this.plugin.licenseInfo = getCompileTrialLicense();
				await this.plugin.saveLicenseInfo();
				new Notice(t("pro.trialStarted", lang));
			}

			await this.refreshVaultStripOnly();
			await this.renderStats();
			await this.renderHistory();

			new Notice(t("compile.complete", lang));
		} catch (e: unknown) {
			const errMsg = e instanceof Error ? e.message : String(e);
			if (errMsg === "编译已取消") {
				this.addLog(t("compile.compiling", lang) + " -- 已取消", "");
			} else if (errMsg === "SB_RAW_MISSING") {
				const msg = t("compile.error.rawMissing", lang, { folder: this.plugin.settings.rawFolder });
				this.addLog(t("compile.fail", lang, { msg }), "err");
				new Notice(t("compile.fail", lang, { msg }));
			} else if (errMsg === "SB_RAW_NO_TEXT") {
				const msg = t("compile.error.rawNoCompilable", lang, { folder: this.plugin.settings.rawFolder });
				this.addLog(t("compile.fail", lang, { msg }), "err");
				new Notice(t("compile.fail", lang, { msg }));
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
			bindHoverHint(this.compileBtn, t("compile.tooltip.start", lang));
			this.cancelBtn.style.display = "none";
			this.timeEstimateEl.style.display = "none";
			this.stopEstimateTimer();
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
			if (tipKey) bindHoverHint(badge, t(tipKey, lang));
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
			bindHoverHint(retryBtn, t("compile.tooltip.retryFailed", lang));
			retryBtn.addEventListener("click", () => {
				summary.remove();
				this.startCompile(force);
			});
		}

			// Next step guidance
			if (errorCount === 0 && totalPages > 0) {
				const guideEl = summary.createDiv({ cls: "sb-compile-guide" });
				const viewBtn = guideEl.createEl("button", { text: t("compile.viewWiki", lang), cls: "sb-compile-guide-btn mod-cta" });
				bindHoverHint(viewBtn, t("compile.tooltip.viewWiki", lang));
				viewBtn.addEventListener("click", () => {
					this.plugin.activateView("second-brain-wiki");
				});
			}

		// 插入到 logEl 之前
		this.logEl.parentElement!.insertBefore(summary, this.logEl);
	}


	private historySummaryLine(entry: CompileHistoryEntry, lang: string): string {
		const tagMap: Record<string, string> = { full: "compile.historyFull", incremental: "compile.historyIncremental", single: "compile.historySingle" };
		const typeLabel = t(tagMap[entry.action] || "compile.historyIncremental", lang);
		const locale = lang === "ja" ? "ja" : lang === "zh-CN" ? "zh-CN" : "en";
		const dateStr = new Date(entry.date).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
		const bits: string[] = [];
		if (entry.added.length > 0) bits.push(t("compile.historyBitAdded", lang, { n: String(entry.added.length) }));
		if (entry.modified.length > 0) bits.push(t("compile.historyBitModified", lang, { n: String(entry.modified.length) }));
		if (entry.removed.length > 0) bits.push(t("compile.historyBitRemoved", lang, { n: String(entry.removed.length) }));
		const changeStr = bits.length > 0 ? bits.join(t("compile.historyBitJoiner", lang)) : t("compile.historyBitNone", lang);
		const sec = Math.round(entry.durationMs / 1000);
		const dur = t("compile.historySeconds", lang, { s: String(sec) });
		return `${dateStr} · ${typeLabel} · ${changeStr} · ${dur}`;
	}

	private async renderHistory() {
		const lang = this.plugin.settings.language;
		this.dataHistoryMount.empty();

		const cache = (await this.plugin.loadData()) as CompileCache | null;
		const history = cache?.compileHistory ?? [];

		if (history.length === 0) {
			if (this.histSectionEl) this.histSectionEl.style.display = "none";
			return;
		}
		if (this.histSectionEl) this.histSectionEl.style.display = "";

		const listWrap = this.dataHistoryMount.createDiv({ cls: "sb-compile-history-cards" });
		for (const entry of history.slice(0, 10)) {
			const line = this.historySummaryLine(entry, lang);
			const hasNames = entry.added.length > 0 || entry.modified.length > 0 || entry.removed.length > 0;
			if (hasNames) {
				const det = listWrap.createEl("details", { cls: "sb-compile-history-card" });
				const sum = det.createEl("summary", { cls: "sb-compile-history-card-sum" });
				sum.createSpan({ cls: "sb-compile-history-card-line", text: line });
				sum.createSpan({ cls: "sb-compile-history-card-hint", text: t("compile.historyTapExpand", lang) });
				const body = det.createDiv({ cls: "sb-compile-history-card-body" });
				body.createEl("div", { cls: "sb-compile-history-names-title", text: t("compile.historyNamesTitle", lang) });
				for (const n of entry.added) body.createEl("div", { text: "+ " + n, cls: "sb-history-detail-item" });
				for (const n of entry.modified) body.createEl("div", { text: "~ " + n, cls: "sb-history-detail-item" });
				for (const n of entry.removed) body.createEl("div", { text: "- " + n, cls: "sb-history-detail-item" });
			} else {
				const row = listWrap.createDiv({ cls: "sb-compile-history-card sb-compile-history-card--plain" });
				row.createEl("div", { cls: "sb-compile-history-card-line", text: line });
			}
		}
	}

	addLog(text: string, cls: string) {
		this.logEl.createDiv({ cls: `sb-log-line ${cls}`, text });
		const scrollHost = this.logEl.parentElement;
		if (scrollHost?.classList.contains("sb-compile-lower-scroll")) {
			scrollHost.scrollTop = scrollHost.scrollHeight;
		} else {
			this.logEl.scrollTop = this.logEl.scrollHeight;
		}
	}

	private async renderStats() {
		const lang = this.plugin.settings.language;
		this.dataStatsMount.empty();

		const cache = (await this.plugin.loadData()) as CompileCache | null;
		const raw = cache?.usageStats;
		const hasRealData = !!(raw && raw.totalCompiles > 0);
		if (!hasRealData || !raw) {
			if (this.statsSectionEl) this.statsSectionEl.style.display = "none";
			return;
		}
		if (this.statsSectionEl) this.statsSectionEl.style.display = "";
		const stats = raw;
		const dl = this.dataStatsMount.createEl("dl", { cls: "sb-compile-stat-dl" });
		const rows: Array<{ dt: string; dd: string }> = [
			{ dt: t("compile.statDlRuns", lang), dd: String(stats.totalCompiles) },
			{ dt: t("compile.statDlSuccess", lang), dd: `${getSuccessRate(stats)}%` },
			{ dt: t("compile.statDlAvg", lang), dd: `${getAvgDurationSec(stats)}s` },
			{ dt: t("compile.statDlConcepts", lang), dd: String(stats.totalConceptsGenerated) },
			{ dt: t("compile.statDlWeek", lang), dd: String(stats.weeklyCompiles) },
		];
		for (const r of rows) {
			const row = dl.createDiv({ cls: "sb-compile-stat-dl-row" });
			row.createEl("dt", { text: r.dt });
			row.createEl("dd", { text: r.dd });
		}
	}

	async onClose() {
		this.cancelCompile();
		if (this.rawRefreshTimer != null) {
			window.clearTimeout(this.rawRefreshTimer);
			this.rawRefreshTimer = null;
		}
	}
}

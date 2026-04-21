// Wiki 预览视图 -- 结构化浏览 + 内联页面预览 + 反向链接

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Component, Notice, TFile, Modal, Menu, setIcon } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { runCompile } from "../core/compile";
import { openPluginSettings } from "../types";
import { readWikiFiles, writeLogEntry, vectorSearch } from "../core/file-utils";
import { computeWikiHealth, WIKI_STALE_THRESHOLD_DAYS } from "../core/health";
import type { WikiHealth } from "../core/health";
import { t } from "../core/i18n";

import { showMoc } from "./wiki-moc";
import { openSynthesisDialog } from "./wiki-synthesis";
import { toggleBatchReview } from "./wiki-batch";
import { setAsyncButton } from "../ui/async-button";
import type { WikiPage, IndexItem, IndexSection, WikiViewCtx } from "./wiki-shared";
import { extractFmField, extractTags, stripFrontmatter, extractStatus, extractUpdated, extractFmArray, extractExecutiveSummary, wikiReviewBucket, wikiStatusNorm, setWikiFrontmatterStatus, resolveWikiPageTarget, countIndexUnresolvedLinks, parseWikiIndexListItem } from "./wiki-shared";
import { hasAnySampleSource, loadSamplesIntoVault } from "../core/sample-loader";

export const VIEW_TYPE_WIKI = "second-brain-wiki";

type WikiIndexEntry = { name: string; display: string; desc: string; section: string; subSection: string };

/** Stable heading ids for in-preview outline links */
function wikiHeadingSlug(text: string, used: Set<string>): string {
	let slug = (text || "section")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9\u4e00-\u9fff-]+/gi, "")
		.replace(/^-+|-+$/g, "") || "section";
	if (slug.length > 64) slug = slug.slice(0, 64);
	let id = slug;
	let n = 0;
	while (used.has(id)) id = `${slug}-${++n}`;
	used.add(id);
	return id;
}

export class WikiView extends ItemView {
	plugin: SecondBrainPlugin;
	private bodyEl: HTMLElement;
	private searchEl: HTMLInputElement;
	private sortSelect: HTMLSelectElement;
	private statusSelect: HTMLSelectElement;
	private wikiPages: WikiPage[] = [];
	private indexData: IndexSection[] = [];
	private currentView: "index" | "page" = "index";
	private currentName = "";
	private navHistory: string[] = [];
	private component: Component;
	private indexBtn: HTMLButtonElement;
	private mocBtn: HTMLButtonElement;
	private sortMode: "name-asc" | "name-desc" | "type" | "level" | "recent" = "name-asc";
	private statusFilter: "all" | "pending" | "reviewed" | "other" = "all";
	private selectedPages = new Set<string>();
	private batchBar: HTMLElement | null = null;
	private pageLimit = 50;
	private searchTimer: ReturnType<typeof setTimeout> | null = null;
	/** View header action buttons (refresh / overflow); removed in onClose to avoid duplicates on reopen */
	private wikiHeaderActionEls: HTMLElement[] = [];
	/** Invalidates stale vectorSearch callbacks after a new index render */
	private indexRenderGeneration = 0;
	/** Scroll position when leaving a wiki page (restore on return / back) */
	private pageScrollTop = new Map<string, number>();

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.component = new Component();
	}

	getViewType(): string { return VIEW_TYPE_WIKI; }
	getDisplayText(): string { return t("cmd.wikiPreview", this.plugin.settings.language); }
	getIcon(): string { return "globe"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.classList.add("second-brain-wiki");
		const lang = this.plugin.settings.language;

		for (const el of this.wikiHeaderActionEls) el.remove();
		this.wikiHeaderActionEls = [];
		this.wikiHeaderActionEls.push(
			this.addAction("refresh-cw", t("wiki.refresh", lang), () => {
				void this.loadWiki();
			}),
		);
		this.wikiHeaderActionEls.push(
			this.addAction("sliders-horizontal", t("wiki.moreMenu", lang), (evt: MouseEvent) => {
				evt.stopPropagation();
				this.openWikiOverflowMenu(evt);
			}),
		);

		const toolbar = container.createDiv({ cls: "sb-wiki-toolbar" });

		const row1 = toolbar.createDiv({ cls: "sb-wiki-toolbar-row1" });

		const toggle = row1.createDiv({ cls: "sb-wiki-view-toggle" });
		this.indexBtn = toggle.createEl("button", { text: t("wiki.tabIndex", lang), cls: "sb-wiki-view-btn active" });
		this.mocBtn = toggle.createEl("button", { text: t("wiki.mocShort", lang), cls: "sb-wiki-view-btn" });
		this.indexBtn.addEventListener("click", () => this.showIndex());
		this.mocBtn.addEventListener("click", () => showMoc(this.ctx()));

		this.searchEl = row1.createEl("input", {
			attr: { placeholder: t("wiki.search", lang), type: "text", "aria-label": t("wiki.search", lang) },
			cls: "sb-wiki-search",
		});

		this.sortSelect = row1.createEl("select", { cls: "sb-wiki-sort sb-wiki-toolbar-select", attr: { title: t("wiki.sortLabel", lang) } });
		const sortOptions: Array<{ value: string; key: string }> = [
			{ value: "name-asc", key: "wiki.sortNameAsc" },
			{ value: "name-desc", key: "wiki.sortNameDesc" },
			{ value: "type", key: "wiki.sortType" },
			{ value: "level", key: "wiki.sortLevel" },
			{ value: "recent", key: "wiki.sortRecent" },
		];
		for (const opt of sortOptions) {
			this.sortSelect.createEl("option", { text: t(opt.key, lang), attr: { value: opt.value } });
		}
		this.sortSelect.value = this.sortMode;
		this.sortSelect.addEventListener("change", () => {
			this.sortMode = this.sortSelect.value as typeof this.sortMode;
			this.renderIndex();
		});
		this.statusSelect = row1.createEl("select", { cls: "sb-wiki-sort sb-wiki-toolbar-select", attr: { title: t("wiki.statusLabel", lang) } });
		const statusOptions: Array<{ value: string; key: string }> = [
			{ value: "all", key: "wiki.filterAll" },
			{ value: "pending", key: "wiki.filterPending" },
			{ value: "reviewed", key: "wiki.statusReviewed" },
			{ value: "other", key: "wiki.filterOther" },
		];
		for (const opt of statusOptions) {
			this.statusSelect.createEl("option", { text: t(opt.key, lang), attr: { value: opt.value } });
		}
		this.statusSelect.value = this.statusFilter;
		this.statusSelect.addEventListener("change", () => {
			this.statusFilter = this.statusSelect.value as typeof this.statusFilter;
			this.renderIndex();
		});

		const quickBar = row1.createDiv({ cls: "sb-wiki-toolbar-quick" });
		const pendingQuick = quickBar.createEl("button", {
			type: "button",
			cls: "sb-wiki-filter-chip",
			text: t("wiki.toolbarFilterPending", lang),
			attr: { title: t("wiki.toolbarFilterPendingTitle", lang) },
		});
		pendingQuick.addEventListener("click", () => this.applyWikiStatusFilter("pending", { resetQuery: true, forceIndex: true }));
		const batchQuick = quickBar.createEl("button", {
			type: "button",
			cls: "sb-wiki-filter-chip sb-wiki-filter-chip-secondary",
			text: t("wiki.batchReview", lang),
			attr: { title: t("wiki.toolbarBatchReviewTitle", lang) },
		});
		batchQuick.addEventListener("click", () => this.onToolbarBatchReview());

		this.bodyEl = container.createDiv({ cls: "sb-wiki-body" });
		// Issue #13: search debounce
		this.searchEl.addEventListener("input", () => {
			if (this.searchTimer) clearTimeout(this.searchTimer);
			this.searchTimer = setTimeout(() => {
				if (this.currentView === "index") this.renderIndex();
			}, 300);
		});

		await this.loadWiki();
	}

	private openWikiOverflowMenu(evt: MouseEvent): void {
		const lang = this.plugin.settings.language;
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle(t("wiki.synthBtn", lang)).setIcon("sparkles").onClick(() => {
				openSynthesisDialog(this.ctx());
			});
		});
		menu.addItem((item) => {
			item.setTitle(t("wiki.batchReview", lang)).setIcon("check-square").onClick(() => {
				this.onToolbarBatchReview();
			});
		});
		menu.showAtMouseEvent(evt);
	}

	private ctx(): WikiViewCtx {
		return {
			app: this.app,
			plugin: this.plugin,
			bodyEl: this.bodyEl,
			wikiPages: this.wikiPages,
			currentView: this.currentView,
			currentName: this.currentName,
			navHistory: this.navHistory,
			indexBtn: this.indexBtn,
			mocBtn: this.mocBtn,
			navigateTo: (name) => this.navigateTo(name),
			loadWiki: () => this.loadWiki(),
			extractType: (c) => extractFmField(c, "type"),
			extractLevel: (c) => extractFmField(c, "level"),
			extractTags: (c) => extractTags(c),
			markAsReviewed: (name: string) => this.markAsReviewed(name),
			markForRegeneration: (name: string) => this.markForRegeneration(name),
			renderIndex: () => this.renderIndex(),
		};
	}

	async loadWiki() {
		const wf = this.plugin.settings.wikiFolder;
		this.wikiPages = await readWikiFiles(this.app, wf);

		const idx = this.wikiPages.find(f => f.path === "index.md" || f.path.endsWith("/index.md"));
		this.indexData = this.parseIndex(idx ? idx.content : "");

		this.currentName = "";
		this.navHistory = [];
		this.pageScrollTop.clear();

		this.currentView = "index";
		this.indexBtn.classList.add("active");
		this.mocBtn.classList.remove("active");
		this.renderIndex();
	}

	private showIndex() {
		this.pageScrollTop.clear();
		this.currentView = "index";
		this.currentName = "";
		this.navHistory = [];
		this.indexBtn.classList.add("active");
		this.mocBtn.classList.remove("active");
		this.renderIndex();
	}

	private applyWikiStatusFilter(
		f: typeof this.statusFilter,
		opts?: { resetQuery?: boolean; forceIndex?: boolean },
	): void {
		this.statusFilter = f;
		if (this.statusSelect) this.statusSelect.value = f;
		if (opts?.resetQuery && this.searchEl?.value) this.searchEl.value = "";
		if (opts?.forceIndex && this.currentView !== "index") {
			this.showIndex();
			return;
		}
		this.renderIndex();
	}

	private onToolbarBatchReview(): void {
		// 再次点击 -> 退出批量模式
		if (this.batchBar && this.batchBar.isConnected) {
			this.selectedPages.clear();
			this.bodyEl.querySelectorAll(".sb-batch-checkbox").forEach(el => el.remove());
			this.batchBar.remove();
			this.batchBar = null;
			return;
		}
		if (this.currentView !== "index") this.showIndex();
		const result = toggleBatchReview(this.ctx(), null, this.batchBar, this.selectedPages);
		this.batchBar = result.batchBar;
	}


	// --- Index ---

	private parseIndex(content: string): IndexSection[] {
		const sections: IndexSection[] = [];
		let cur: IndexSection | null = null;
		let sub: { title: string; items: IndexItem[] } | null = null;

		for (const line of content.split("\n")) {
			const h2 = line.match(/^## (.+)/);
			const h3 = line.match(/^### (.+)/);
			const parsed = parseWikiIndexListItem(line);

			if (h2) {
				cur = { title: h2[1], subs: [] };
				sections.push(cur);
				sub = null;
			} else if (h3 && cur) {
				sub = { title: h3[1], items: [] };
				cur.subs.push(sub);
			} else if (parsed) {
				const entry: IndexItem = parsed;
				if (sub) {
					sub.items.push(entry);
				} else if (cur) {
					sub = { title: "", items: [entry] };
					cur.subs.push(sub);
				}
			}
		}
		return sections;
	}

	private sortPageEntries(entries: WikiIndexEntry[]): WikiIndexEntry[] {
		const copy = [...entries];
		const page = (name: string) => this.findPage(name);
		const getUpdated = (name: string) => extractUpdated(page(name)?.content || "") || "";
		const getType = (name: string) => (page(name) ? extractFmField(page(name)!.content, "type") : "") || "";
		const getLevel = (name: string) => (page(name) ? extractFmField(page(name)!.content, "level") : "") || "";
		const cmpName = (a: WikiIndexEntry, b: WikiIndexEntry) =>
			a.display.localeCompare(b.display, undefined, { sensitivity: "base" });

		switch (this.sortMode) {
			case "name-asc":
				copy.sort(cmpName);
				break;
			case "name-desc":
				copy.sort((a, b) => -cmpName(a, b));
				break;
			case "type":
				copy.sort((a, b) => getType(a.name).localeCompare(getType(b.name)) || cmpName(a, b));
				break;
			case "level":
				copy.sort((a, b) => getLevel(a.name).localeCompare(getLevel(b.name)) || cmpName(a, b));
				break;
			case "recent":
				copy.sort((a, b) => getUpdated(b.name).localeCompare(getUpdated(a.name)) || cmpName(a, b));
				break;
		}
		return copy;
	}

	private appendWikiListRow(
		container: HTMLElement,
		entry: WikiIndexEntry,
		lang: string,
		opts?: { semantic?: boolean },
	): void {
		const page = this.findPage(entry.name);
		const path = page?.path || "";
		const kind: "concept" | "entity" | "source" | "other" = path.includes("concepts/")
			? "concept"
			: path.includes("entities/")
				? "entity"
				: path.includes("sources/")
					? "source"
					: "other";
		const kindKey = kind === "concept" ? "wiki.kindShortConcept" : kind === "entity" ? "wiki.kindShortEntity" : kind === "source" ? "wiki.kindShortSource" : "wiki.kindShortOther";
		const row = container.createDiv({
			cls: "sb-wiki-list-row" + (opts?.semantic ? " sb-wiki-list-row-semantic" : ""),
			attr: { "data-name": entry.name },
		});
		if (path) row.setAttribute("data-path", path);
		row.setAttribute("role", "button");
		row.tabIndex = 0;
		row.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				this.navigateTo(entry.name);
			}
		});
		row.addEventListener("click", (ev) => {
			if ((ev.target as HTMLElement).closest(".sb-batch-checkbox")) return;
			this.navigateTo(entry.name);
		});

		const kindEl = row.createDiv({ cls: `sb-wiki-list-kind sb-wiki-list-kind-${kind}`, text: t(kindKey, lang) });
		kindEl.setAttribute("aria-hidden", "true");

		const main = row.createDiv({ cls: "sb-wiki-list-main" });
		main.createEl("div", { text: entry.display, cls: "sb-wiki-list-title" });
		const trail = [entry.section, entry.subSection].filter(Boolean).join(" › ");
		if (trail) main.createDiv({ cls: "sb-wiki-list-path", text: trail });
		if (entry.desc) main.createEl("div", { cls: "sb-wiki-list-desc", text: entry.desc.slice(0, 160) });
		const tags = page ? extractTags(page.content) : [];
		if (tags.length > 0) {
			const tagRow = main.createDiv({ cls: "sb-wiki-list-tags" });
			for (const tag of tags.slice(0, 4)) {
				tagRow.createEl("span", { text: tag, cls: "sb-wiki-list-tag" });
			}
		}

		const meta = row.createDiv({ cls: "sb-wiki-list-meta" });
		if (page) {
			const psRaw = extractStatus(page.content).trim();
			const ps = wikiStatusNorm(page.content);
			const bucket = wikiReviewBucket(page.content);
				row.setAttribute("data-bucket", bucket);
				if (bucket === "pending") {
				const pendingLabel = psRaw === "" ? t("wiki.statusPendingUnmarked", lang)
					: ps === "pending" ? t("wiki.statusPendingKeyword", lang)
						: t("wiki.statusDraft", lang);
				meta.createEl("span", {
					cls: "sb-wiki-list-status sb-wiki-list-status-draft",
					text: pendingLabel,
				});
			} else if (bucket === "reviewed") {
				meta.createEl("span", { cls: "sb-wiki-list-status sb-wiki-list-status-reviewed", text: t("wiki.statusReviewed", lang) });
			} else if (ps === "gap") {
				meta.createEl("span", { cls: "sb-wiki-list-status sb-wiki-list-status-gap", text: t("wiki.statusGapShort", lang) });
			} else if (ps === "outdated") {
				meta.createEl("span", { cls: "sb-wiki-list-status sb-wiki-list-status-outdated", text: t("wiki.statusOutdatedShort", lang) });
			} else {
				meta.createEl("span", { cls: "sb-wiki-list-status sb-wiki-list-status-other", text: psRaw || t("wiki.statusUnknownShort", lang) });
			}
			const d = extractUpdated(page.content);
			if (d) meta.createEl("span", { cls: "sb-wiki-list-date", text: d });
		}
	}

	private renderWikiEmpty(lang: string): void {
		this.bodyEl.createDiv({ cls: "sb-wiki-empty" });
		const guidance = this.bodyEl.createDiv({ cls: "sb-wiki-empty-guidance" });
		guidance.createEl("h3", { text: t("empty.wikiTitle", lang) });
		const steps = guidance.createDiv({ cls: "sb-empty-steps" });
		const step1 = steps.createDiv({ cls: "sb-empty-step" });
		step1.createEl("span", { text: "1", cls: "sb-empty-step-num" });
		step1.createEl("span", { text: t("empty.step1Put", lang), cls: "sb-empty-step-text" });
		const hasSampleSource = hasAnySampleSource(this.app);
		const rawFolder = this.plugin.settings.rawFolder;
		const wikiFolder = this.plugin.settings.wikiFolder;
		const rawDir = this.app.vault.getAbstractFileByPath(rawFolder);
		let rawHasFiles = false;
		if (rawDir) {
			const allFiles = this.app.vault.getFiles();
			rawHasFiles = allFiles.some(f => f.path.startsWith(rawFolder + "/") && !f.path.includes("_usage"));
		}
		if (!rawHasFiles && hasSampleSource) {
			const sampleBtn = guidance.createEl("button", { text: t("empty.loadSamples", lang), cls: "sb-empty-btn" });
			sampleBtn.style.marginBottom = "8px";
			sampleBtn.addEventListener("click", async () => {
				sampleBtn.textContent = "...";
				try {
					await loadSamplesIntoVault(this.app, rawFolder, wikiFolder);
					sampleBtn.textContent = t("empty.samplesLoaded", lang);
				} catch (e) {
					sampleBtn.textContent = t("empty.samplesFail", lang);
				}
			});
		}
		const step2 = steps.createDiv({ cls: "sb-empty-step" });
		step2.createEl("span", { text: "2", cls: "sb-empty-step-num" });
		step2.createEl("span", { text: t("empty.step2Compile", lang), cls: "sb-empty-step-text" });
		const step3 = steps.createDiv({ cls: "sb-empty-step" });
		step3.createEl("span", { text: "3", cls: "sb-empty-step-num" });
		step3.createEl("span", { text: t("empty.step3Browse", lang), cls: "sb-empty-step-text" });
		const btnRow = guidance.createDiv({ cls: "sb-empty-btn-row" });
		btnRow.createEl("button", { text: t("empty.openSettings", lang), cls: "sb-empty-btn" })
			.addEventListener("click", () => openPluginSettings(this.app));
		btnRow.createEl("button", { text: t("empty.startCompile", lang), cls: "sb-empty-btn mod-cta" })
			.addEventListener("click", () => this.plugin.activateView("second-brain-compile"));
	}

	/** Wiki 索引顶部的数据面板：紧凑行内布局，每个问题配动作按钮 */
	private buildWikiDataPanel(
		lang: string,
		cc: number,
		ec: number,
		sc: number,
		health: WikiHealth,
		indexMissingLinks: number,
	): void {
		const days = String(WIKI_STALE_THRESHOLD_DAYS);
		const totalPages = health.total;
		const pendingCount = health.pending;
		const otherCount = health.other;
		const reviewedCount = health.reviewed;
		const reviewPct = totalPages > 0 ? Math.round((reviewedCount / totalPages) * 100) : 0;

		// --- 概览行 ---
		const overview = this.bodyEl.createDiv({ cls: "sb-qa-overview" });
		const stats = overview.createDiv({ cls: "sb-qa-stats" });
		stats.createEl("span", { cls: "sb-qa-stat-num", text: String(totalPages) });
		stats.createEl("span", { cls: "sb-qa-stat-label", text: t("wiki.statTotal", lang, { n: "" }).replace(/[\s]*$/, "") });
		const pieces = [
			t("wiki.statConcepts", lang, { n: String(cc) }),
			t("wiki.statEntities", lang, { n: String(ec) }),
			t("wiki.statSources", lang, { n: String(sc) }),
		];
		let statsText = pieces[0];
		for (let i = 1; i < pieces.length; i++) statsText += " · " + pieces[i];
		stats.createEl("span", { cls: "sb-qa-stat-breakdown", text: statsText });
		// 审核进度
		const progRow = overview.createDiv({ cls: "sb-qa-prog" });
		progRow.createEl("span", { cls: "sb-qa-prog-label", text: `${reviewedCount}/${totalPages}` });
		const progBar = progRow.createDiv({ cls: "sb-qa-prog-bar" });
		progBar.createDiv({ cls: "sb-qa-prog-fill", attr: { style: `width:${reviewPct}%` } });
		progRow.createEl("span", { cls: "sb-qa-prog-pct", text: `${reviewPct}%` });

		if (totalPages === 0) {
			this.bodyEl.createEl("p", { cls: "sb-wiki-data-section-text", text: t("wiki.dataPanelNoPages", lang) });
			return;
		}

		// --- 待处理事项 ---
		const hasIssues = pendingCount > 0 || health.gapPages > 0 || health.staleness > 30 || health.orphanRisk > 20 || indexMissingLinks > 0 || otherCount > 0;

		if (hasIssues) {
			this.bodyEl.createEl("div", { cls: "sb-qa-section-label", text: t("wiki.actionCardTitle", lang) });
		}

		const list = this.bodyEl.createDiv({ cls: "sb-qa-list" });

		// 1) 待审核
		if (pendingCount > 0) {
			const row = this.buildIssueRow(list, {
				severity: "warn",
				title: t("wiki.issuePending", lang, { n: String(pendingCount) }),
				actionLabel: t("wiki.issuePendingAction", lang),
				onAction: () => this.applyWikiStatusFilter("pending"),
			});
			row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issuePendingDesc", lang) });
		}

		// 2) 知识缺口
		if (health.gapPages > 0) {
			const row = this.buildIssueRow(list, {
				severity: "err",
				title: t("wiki.issueGap", lang, { n: String(health.gapPages) }),
				actionLabel: t("wiki.issueGapAction", lang),
				onAction: (btn) => void this.runActionCompile(btn, lang),
			});
			row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueGapDesc", lang) });
		}

		// 3) 概念过时
		if (health.staleness > 30) {
			const row = this.buildIssueRow(list, {
				severity: "warn",
				title: t("wiki.issueStale", lang, { pct: String(health.staleness), days }),
				actionLabel: t("wiki.issueStaleAction", lang),
				onAction: (btn) => void this.runActionCompile(btn, lang),
			});
			if (health.stalePages.length > 0) {
				const sub = row.createDiv({ cls: "sb-qa-stale-sub" });
				for (const sp of health.stalePages) {
					const sr = sub.createDiv({ cls: "sb-qa-stale-row" });
					sr.createEl("a", { text: sp.name, cls: "sb-qa-stale-name" }).addEventListener("click", (ev) => {
						ev.preventDefault();
						void this.navigateTo(sp.name);
					});
					sr.createEl("span", { cls: "sb-qa-stale-days", text: t("health.daysAgo", lang, { n: String(sp.daysSinceUpdate) }) });
					sr.createEl("button", { cls: "sb-qa-stale-regen", text: t("wiki.issueStaleRegen", lang) })
						.addEventListener("click", async (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							(ev.target as HTMLElement).textContent = "...";
							await this.markForRegeneration(sp.path);
						});
				}
			}
		}

		// 4) 孤岛风险
		if (health.orphanRisk > 20) {
			const row = this.buildIssueRow(list, {
				severity: "info",
				title: t("wiki.issueOrphan", lang, { pct: String(health.orphanRisk) }),
				actionLabel: t("wiki.issueOrphanAction", lang),
				onAction: (btn) => void this.runActionCompile(btn, lang),
			});
			row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueOrphanDesc", lang) });
		}

		// 5) 索引链接失效
		if (indexMissingLinks > 0) {
			const row = this.buildIssueRow(list, {
				severity: "info",
				title: t("wiki.issueIndexMissing", lang, { n: String(indexMissingLinks) }),
			});
			row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueIndexMissingDesc", lang) });
		}

		// 6) 其他状态
		if (otherCount > 0 && pendingCount === 0) {
			const row = this.buildIssueRow(list, {
				severity: "info",
				title: t("wiki.issueOther", lang, { n: String(otherCount) }),
				actionLabel: t("wiki.issueOtherAction", lang),
				onAction: () => this.applyWikiStatusFilter("other"),
			});
			row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueOtherDesc", lang) });
		}

		// 一切正常
		if (!hasIssues) {
			this.bodyEl.createDiv({ cls: "sb-qa-all-clear", text: t("wiki.issueAllClear", lang) });
		}
	}

	/** 构建一行问题条目 (dot + title + action button) */
	private buildIssueRow(
		container: HTMLElement,
		opts: {
			severity: "err" | "warn" | "info";
			title: string;
			actionLabel?: string;
			onAction?: (btn: HTMLButtonElement) => void;
		},
	): HTMLElement {
		const row = container.createDiv({ cls: "sb-qa-row" });
		row.createDiv({ cls: `sb-qa-dot sb-qa-dot-${opts.severity}` });
		row.createEl("div", { cls: "sb-qa-row-title", text: opts.title });
		if (opts.actionLabel && opts.onAction) {
			row.createEl("button", { cls: "sb-qa-row-btn", text: opts.actionLabel, attr: { type: "button" } })
				.addEventListener("click", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					opts.onAction!(ev.target as HTMLButtonElement);
				});
		}
		return row;
	}

	/** 行内"重新编译"动作 */
	private async runActionCompile(btn: HTMLButtonElement, lang: string): Promise<void> {
		if (!this.plugin.settings.apiKey) {
			new Notice(t("notice.noApiKey", lang));
			return;
		}
		const orig = btn.textContent || "";
		btn.textContent = t("wiki.actionRunning", lang);
		btn.setAttribute("disabled", "true");
		try {
			await this.plugin.runWithCompileLock(() =>
				runCompile(this.app, this.plugin.settings, () => {}, false, this.plugin),
			);
			await this.loadWiki();
			new Notice(t("notice.compileDone", lang, { n: String(this.wikiPages.length) }));
		} catch (e) {
			new Notice(t("wiki.healthRepairFailed", lang, { msg: (e as Error).message }));
		} finally {
			btn.textContent = orig;
			btn.removeAttribute("disabled");
		}
	}

	private renderIndex(): void {
		const query = (this.searchEl?.value || "").toLowerCase();
		const lang = this.plugin.settings.language;
		const indexGen = ++this.indexRenderGeneration;
		if (this.sortSelect) this.sortSelect.value = this.sortMode;
		if (this.statusSelect) this.statusSelect.value = this.statusFilter;
		this.bodyEl.empty();
		this.batchBar = null;
		this.selectedPages.clear();

		if (this.wikiPages.length === 0) {
			this.renderWikiEmpty(lang);
			return;
		}

		if (!query) {
			const cc = this.wikiPages.filter(f => f.path.includes("concepts/")).length;
			const ec = this.wikiPages.filter(f => f.path.includes("entities/")).length;
			const sc = this.wikiPages.filter(f => f.path.includes("sources/")).length;
			const health = computeWikiHealth(this.wikiPages);
			const indexMissingLinks = countIndexUnresolvedLinks(this.indexData, this.wikiPages);
			this.buildWikiDataPanel(lang, cc, ec, sc, health, indexMissingLinks);

		} else {
			const matchCount = this.wikiPages.filter(f => {
				const name = f.path.split("/").pop()!.replace(".md", "");
				if (name === "index" || name === "log") return false;
				return name.toLowerCase().includes(query) || f.content.toLowerCase().includes(query);
			}).length;
			this.bodyEl.createEl("p", { text: t("wiki.searchResultsCount", lang, { n: String(matchCount) }), cls: "sb-wiki-search-hint" });
		}

// 统一页面列表：合并 index 条目和非 index 页面
			const indexedPaths = new Set<string>();

			const entries: WikiIndexEntry[] = [];

			// index 条目
			for (const sec of this.indexData) {
				for (const sub of sec.subs) {
					for (const item of sub.items) {
						entries.push({ name: item.name, display: item.display, desc: item.desc || "", section: sec.title, subSection: sub.title });
						const hit = this.findPage(item.name);
						if (hit) indexedPaths.add(hit.path);
					}
				}
			}

			// 不在 index 中的页面
			for (const f of this.wikiPages) {
				const name = f.path.split("/").pop()!.replace(".md", "");
				if (name === "index" || name === "log") continue;
				if (indexedPaths.has(f.path)) continue;
				const fmTitle = f.content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
				const stripped = f.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
				const firstLine = stripped.split("\n").find((l: string) => l.trim() && !l.startsWith("#") && !l.startsWith(">")) || "";
				const nameTaken = entries.some(e => e.name === name);
				const targetName = nameTaken ? f.path : name;
				entries.push({ name: targetName, display: fmTitle ? fmTitle[1] : name, desc: firstLine.slice(0, 120), section: "", subSection: "" });
			}

			// 搜索过滤：关键词 + 语义
			let filtered = entries;
			if (query) {
				const keywordMatch = new Set(entries.filter((e: WikiIndexEntry) => {
					if (e.name.toLowerCase().includes(query) || e.display.toLowerCase().includes(query) || e.desc.toLowerCase().includes(query)) return true;
					const page = this.findPage(e.name);
					return page != null && page.content.toLowerCase().includes(query);
				}).map(e => e.name));

				// 后台语义搜索，有结果时追加渲染
				const filesMap: Record<string, string> = {};
				for (const p of this.wikiPages) filesMap[p.path] = p.content;
				vectorSearch(query, filesMap, this.plugin.settings, 10).then(results => {
					if (indexGen !== this.indexRenderGeneration || this.currentView !== "index") return;
					const semanticNames = new Set<string>();
					for (const r of results) {
						const name = r.filePath.split("/").pop()!.replace(".md", "");
						if (!keywordMatch.has(name)) semanticNames.add(name);
						semanticNames.add(r.filePath.replace(/\\/g, "/"));
					}
					if (semanticNames.size === 0) return;
					const semEntries = entries.filter(e => semanticNames.has(e.name));
					if (semEntries.length === 0) return;
					const host = this.bodyEl.querySelector(".sb-wiki-index-scroll");
					if (!host) return;
					host.createEl("h2", { text: t("wiki.semanticMatch", lang), cls: "sb-wiki-h2 sb-wiki-list-section-title" });
					const semList = host.createDiv({ cls: "sb-wiki-list sb-wiki-list-semantic" });
					for (const entry of this.sortPageEntries(semEntries)) {
						this.appendWikiListRow(semList, entry, lang, { semantic: true });
					}
				}).catch(() => {});

				filtered = entries.filter(e => keywordMatch.has(e.name));
			}

			if (this.statusFilter !== "all") {
				filtered = filtered.filter((e: WikiIndexEntry) => {
					const page = this.findPage(e.name);
					if (!page) return false;
					return wikiReviewBucket(page.content) === this.statusFilter;
				});
			}

			const sorted = this.sortPageEntries(filtered);
				// 筛选结果为空且非 all 筛选 -> 自动重置
				if (sorted.length === 0 && this.statusFilter !== "all" && entries.length > 0) {
					this.statusFilter = "all";
					if (this.statusSelect) this.statusSelect.value = "all";
					return this.renderIndex();
				}
			const listMount = this.bodyEl.createDiv({ cls: "sb-wiki-index-scroll" });
			listMount.createEl("h2", { text: t("wiki.pagesHeading", lang), cls: "sb-wiki-h2 sb-wiki-list-section-title" });
			const listRoot = listMount.createDiv({ cls: "sb-wiki-list" });
			const visible = sorted.slice(0, this.pageLimit);
			for (const entry of visible) {
				this.appendWikiListRow(listRoot, entry, lang);
			}
			if (sorted.length === 0) {
				listRoot.createDiv({ cls: "sb-wiki-list-empty", text: t("wiki.listEmpty", lang) });
			}

			if (sorted.length > this.pageLimit) {
				const loadMoreBtn = listMount.createEl("button", {
					text: t("wiki.loadMore", lang, { n: String(sorted.length - this.pageLimit) }),
					cls: "sb-wiki-load-more",
				});
				loadMoreBtn.addEventListener("click", () => {
					this.pageLimit += 50;
					this.renderIndex();
				});
			}
	}

	// --- Page ---

	private async navigateTo(name: string) {
		if (this.currentView === "page" && this.currentName) {
			this.pageScrollTop.set(this.currentName, this.bodyEl.scrollTop);
		}
		const marker = this.currentName;
		this.navHistory.push(marker);
		this.currentName = name;
		this.currentView = "page";
		this.indexBtn.classList.remove("active");
		this.mocBtn.classList.remove("active");
		await this.renderPage(name);
	}

	private async goBack() {
		if (this.currentView === "page" && this.currentName) {
			this.pageScrollTop.set(this.currentName, this.bodyEl.scrollTop);
		}
		const prev = this.navHistory.pop();
		if (!prev || prev === "") {
			this.showIndex();
			return;
		}
		this.currentName = prev;
		this.currentView = "page";
		await this.renderPage(prev);
	}

	private async renderPage(name: string) {
		const lang = this.plugin.settings.language;
		this.bodyEl.empty();
		const page = this.findPage(name);
		if (!page) {
			this.bodyEl.createDiv({ cls: "sb-wiki-empty", text: t("wiki.pageNotFound", lang, { name }) });
			return;
		}

		const breadcrumb = this.bodyEl.createDiv({ cls: "sb-wiki-breadcrumb" });
		const backBtn = breadcrumb.createEl("button", { cls: "sb-wiki-back", attr: { "aria-label": t("wiki.backNav", lang) } });
		backBtn.addEventListener("click", () => this.goBack());
		const backIcon = backBtn.createSpan({ cls: "sb-wiki-back-icon-wrap" });
		setIcon(backIcon, "arrow-left");
		backBtn.createSpan({ text: t("wiki.backNav", lang), cls: "sb-wiki-back-text" });
		breadcrumb.createEl("span", { text: name, cls: "sb-wiki-breadcrumb-title" });

		breadcrumb.createEl("button", { text: t("wiki.openEditor", lang), cls: "sb-wiki-edit-btn" })
			.addEventListener("click", () => this.openInEditor(name));

		// 审核横幅放在最上：长文/摘要/素材区会把按钮顶出首屏，易被误认为「没有审核」
		this.renderWikiReviewBanner(lang, name, page);

		const expressBtn = breadcrumb.createEl("button", { text: t("wiki.generateArticle", lang), cls: "sb-wiki-generate-btn" });
		expressBtn.addEventListener("click", async () => {
			// Issue #2: confirmation modal before generating
			const confirmed = await new Promise<boolean>((resolve) => {
				const modal = new Modal(this.app);
				modal.titleEl.setText(t("wiki.generateArticle", lang));
				modal.contentEl.createEl("p", { text: t("wiki.generateArticleConfirm", lang) });
				const btnRow = modal.contentEl.createDiv();
				btnRow.style.display = "flex";
				btnRow.style.gap = "8px";
				btnRow.style.justifyContent = "flex-end";
				btnRow.createEl("button", { text: t("set.cancel", lang) }).addEventListener("click", () => { modal.close(); resolve(false); });
				btnRow.createEl("button", { text: t("wiki.generateArticle", lang), cls: "mod-cta" }).addEventListener("click", () => { modal.close(); resolve(true); });
				modal.open();
			});
			if (!confirmed) return;

			setAsyncButton(expressBtn, true);
			try {
				const { callLLM } = await import("../core/llm");
				const { ensureFolder } = await import("../core/file-utils");
				const strippedContent = stripFrontmatter(page.content);
				const today = new Date().toISOString().split("T")[0];
				const result = await callLLM([
					{ role: "system", content: "Writer. Transform wiki page into a polished article. Same language as source. Keep wikilinks [[PageName]]." },
					{ role: "user", content: `Write an article from this wiki page:\n${strippedContent.slice(0, 6000)}` },
				], this.plugin.settings, { maxTokens: 3000, temperature: 0.5 });
				const article = `---\ntitle: "${name}"\ntype: article\nsource_wiki: "${page.path}"\nlast_updated: ${today}\n---\n\n${result.trim()}\n`;
				await ensureFolder(this.app, "blog");
				const blogPath = `blog/${name}-${today}.md`;
				const existing = this.app.vault.getAbstractFileByPath(blogPath);
				if (existing instanceof TFile) await this.app.vault.modify(existing, article);
				else await this.app.vault.create(blogPath, article);
				setAsyncButton(expressBtn, false, t("wiki.articleGenerated", lang));
				new Notice(t("wiki.articleGeneratedNotice", lang));
			} catch (e) {
				setAsyncButton(expressBtn, false, t("wiki.generateArticle", lang));
				new Notice(t("wiki.generateFailed", lang));
			}
		});

		const metaRow = this.bodyEl.createDiv({ cls: "sb-wiki-meta" });
		const fmType = extractFmField(page.content, "type");
		const fmLevel = extractFmField(page.content, "level");
		const fmUpdated = extractUpdated(page.content);
		if (fmType) {
			const badge = metaRow.createDiv({ cls: "sb-wiki-meta-badge" });
			badge.createEl("span", { text: t("wiki.metaType", lang), cls: "sb-wiki-meta-label" });
			badge.createEl("span", { text: fmType, cls: "sb-wiki-meta-value" });
		}
		if (fmLevel) {
			const badge = metaRow.createDiv({ cls: "sb-wiki-meta-badge" });
			badge.createEl("span", { text: t("wiki.metaLevel", lang), cls: "sb-wiki-meta-label" });
			badge.createEl("span", { text: fmLevel, cls: "sb-wiki-meta-value" });
		}
		if (fmUpdated) {
			const badge = metaRow.createDiv({ cls: "sb-wiki-meta-badge" });
			badge.createEl("span", { text: t("wiki.metaUpdated", lang), cls: "sb-wiki-meta-label" });
			badge.createEl("span", { text: fmUpdated, cls: "sb-wiki-meta-value" });
		}

		const execSummary = extractExecutiveSummary(page.content);
		if (execSummary) {
			const sumEl = this.bodyEl.createDiv({ cls: "sb-wiki-executive-summary" });
			sumEl.createEl("div", { text: t("wiki.executiveSummaryTitle", lang), cls: "sb-wiki-executive-summary-title" });
			sumEl.createEl("div", { text: execSummary, cls: "sb-wiki-executive-summary-body" });
		}

		// Feature 3: Source citation display
		const originalSources = extractFmArray(page.content, "original");
		const referenceSources = extractFmArray(page.content, "reference");
		if (originalSources.length > 0 || referenceSources.length > 0) {
			const sourcesEl = this.bodyEl.createDiv({ cls: "sb-wiki-sources" });
			sourcesEl.createEl("h4", { text: t("wiki.sourcesLabel", lang), cls: "sb-wiki-sources-title" });
			if (originalSources.length > 0) {
				const origSection = sourcesEl.createDiv({ cls: "sb-wiki-source-group" });
				origSection.createEl("span", { text: t("wiki.originalSources", lang), cls: "sb-wiki-source-type-label" });
				for (const src of originalSources) {
					const chip = origSection.createEl("a", { text: src.split("/").pop() || src, cls: "sb-wiki-source-chip sb-wiki-source-original" });
					chip.addEventListener("click", (ev) => {
						ev.preventDefault();
						const file = this.app.vault.getAbstractFileByPath(src);
						if (file instanceof TFile) {
							this.app.workspace.getLeaf(false).openFile(file);
						}
					});
				}
			}
			if (referenceSources.length > 0) {
				const refSection = sourcesEl.createDiv({ cls: "sb-wiki-source-group" });
				refSection.createEl("span", { text: t("wiki.referenceSources", lang), cls: "sb-wiki-source-type-label" });
				for (const src of referenceSources) {
					const chip = refSection.createEl("a", { text: src.split("/").pop() || src, cls: "sb-wiki-source-chip sb-wiki-source-reference" });
					chip.addEventListener("click", (ev) => {
						ev.preventDefault();
						const file = this.app.vault.getAbstractFileByPath(src);
						if (file instanceof TFile) {
							this.app.workspace.getLeaf(false).openFile(file);
						}
					});
				}
			}
		}

		const pageWrap = this.bodyEl.createDiv({ cls: "sb-wiki-page-wrap" });
		const tocCol = pageWrap.createDiv({ cls: "sb-wiki-toc-col" });
		const contentEl = pageWrap.createDiv({ cls: "sb-wiki-page-content" });
		const stripped = stripFrontmatter(page.content);
		const wf = this.plugin.settings.wikiFolder;
		const sourcePath = `${wf}/${page.path}`;
		this.component.unload();
		this.component = new Component();
		await MarkdownRenderer.render(this.app, stripped, contentEl, sourcePath, this.component);

		this.attachPageOutline(lang, tocCol, contentEl);
		this.wireInternalLinks(contentEl, wf);

		const savedScroll = this.pageScrollTop.get(name);
		if (savedScroll != null) {
			requestAnimationFrame(() => {
				this.bodyEl.scrollTop = savedScroll;
				this.pageScrollTop.delete(name);
			});
		}

		const backlinks = this.findBacklinks(name);
		if (backlinks.length > 0) {
			this.bodyEl.createEl("h3", { text: t("wiki.backlinks", lang), cls: "sb-wiki-backlinks-title" });
			const blGrid = this.bodyEl.createDiv({ cls: "sb-wiki-backlinks-grid" });
			for (const bl of backlinks) {
				blGrid.createEl("a", { text: bl.display, cls: "sb-wiki-backlink-chip" })
					.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(bl.name); });
			}
		}
	}

	private attachPageOutline(lang: string, tocCol: HTMLElement, contentEl: HTMLElement): void {
		tocCol.empty();
		tocCol.style.display = "none";

		const headings = Array.from(contentEl.querySelectorAll<HTMLElement>("h1, h2, h3"));
		if (headings.length < 2) return;

		const used = new Set<string>();
		for (const h of headings) {
			if (!h.id) {
				h.id = wikiHeadingSlug(h.textContent || "section", used);
			} else {
				used.add(h.id);
			}
		}

		tocCol.style.display = "";
		tocCol.createEl("div", { text: t("wiki.pageOutline", lang), cls: "sb-wiki-toc-title" });
		const nav = tocCol.createEl("nav", { cls: "sb-wiki-toc-nav" });
		for (const h of headings) {
			const level = h.tagName === "H1" ? 1 : h.tagName === "H2" ? 2 : 3;
			const a = nav.createEl("a", {
				cls: `sb-wiki-toc-link sb-wiki-toc-level-${level}`,
				text: h.textContent?.trim() || "",
				attr: { href: "#" + h.id },
			});
			a.addEventListener("click", (ev) => {
				ev.preventDefault();
				h.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	}

	private wireInternalLinks(contentEl: HTMLElement, wikiFolder: string): void {
		contentEl.querySelectorAll("a.internal-link").forEach((link: HTMLAnchorElement) => {
			const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
			const targetName = href.split("/").pop()!.replace(".md", "").split("|")[0].split("#")[0];
			const target = this.findPage(targetName);
			if (!target) link.classList.add("is-unresolved");

			link.addEventListener("click", (ev) => {
				if (ev.metaKey || ev.ctrlKey) {
					ev.preventDefault();
					ev.stopPropagation();
					if (target) {
						const fullPath = `${wikiFolder}/${target.path}`;
						const file = this.app.vault.getAbstractFileByPath(fullPath);
						if (file instanceof TFile) {
							this.app.workspace.getLeaf("tab").openFile(file);
						}
					}
					return;
				}
				ev.preventDefault();
				ev.stopPropagation();
				this.navigateTo(targetName);
			});
		});
	}

	/** gap / outdated / 待审核 / 已审核 的操作条：置顶，避免被摘要与素材区挤出视口 */
	private renderWikiReviewBanner(lang: string, name: string, page: WikiPage): void {
		const sn = wikiStatusNorm(page.content);
		const rawStatus = extractStatus(page.content).trim();

		if (sn === "gap") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			banner.createEl("span", { text: t("wiki.gap", lang), cls: "sb-draft-label" });
			const regenBtn = banner.createEl("button", { text: t("wiki.regeneratePage", lang), cls: "sb-draft-review-btn" });
			regenBtn.addEventListener("click", async () => {
				await this.markForRegeneration(page.path);
				regenBtn.textContent = t("wiki.regeneratePageDone", lang);
				regenBtn.setAttribute("disabled", "true");
			});
		} else if (sn === "outdated") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			banner.createEl("span", { text: t("wiki.outdated", lang), cls: "sb-draft-label" });
			const regenBtn = banner.createEl("button", { text: t("wiki.regeneratePage", lang), cls: "sb-draft-review-btn" });
			regenBtn.addEventListener("click", async () => {
				await this.markForRegeneration(page.path);
				regenBtn.textContent = t("wiki.regeneratePageDone", lang);
				regenBtn.setAttribute("disabled", "true");
			});
		} else if (sn === "draft" || sn === "" || sn === "pending") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			const label = rawStatus === "" ? t("wiki.statusPendingUnmarked", lang)
				: sn === "pending" ? t("wiki.statusPendingKeyword", lang)
					: t("wiki.draft", lang);
			banner.createEl("span", { text: label, cls: "sb-draft-label" });
			const reviewBtn = banner.createEl("button", { text: t("wiki.markReviewed", lang), cls: "sb-draft-review-btn" });
			reviewBtn.addEventListener("click", async () => {
				await this.markAsReviewed(page.path);
				await this.renderPage(name);
			});
		} else if (sn === "reviewed") {
			const banner = this.bodyEl.createDiv({ cls: "sb-reviewed-banner" });
			banner.createEl("span", { text: t("wiki.reviewed", lang), cls: "sb-draft-label" });
			const summaryBtn = banner.createEl("button", { text: t("wiki.distillSummary", lang), cls: "sb-draft-review-btn" });
			summaryBtn.addEventListener("click", async () => {
				summaryBtn.textContent = "...";
				try {
					const { callLLM } = await import("../core/llm");
					const strippedContent = stripFrontmatter(page.content);
					const result = await callLLM([
						{ role: "system", content: "Knowledge distiller. 2-3 sentence executive summary in the page's language." },
						{ role: "user", content: `Summarize key insight in 2-3 sentences:\n\n${strippedContent.slice(0, 4000)}` },
					], this.plugin.settings, { maxTokens: 200, temperature: 0.2 });
					const summary = result.trim();
					let updated = page.content;
					if (/^executive_summary:/m.test(updated)) {
						updated = updated.replace(/^executive_summary:.*$/m, `executive_summary: "${summary.replace(/"/g, '\\"')}"`);
					} else {
						updated = updated.replace(/^(---\n)/, `$1executive_summary: "${summary.replace(/"/g, '\\"')}"\n`);
					}
					const wf = this.plugin.settings.wikiFolder;
					const fullPath = `${wf}/${page.path}`;
					const file = this.app.vault.getAbstractFileByPath(fullPath);
					if (file instanceof TFile) {
						await this.app.vault.modify(file, updated);
						page.content = updated;
					}
					summaryBtn.textContent = t("wiki.summaryDistilled", lang);
					summaryBtn.classList.add("mod-cta");
					new Notice(t("wiki.summaryDistilledHint", lang));
					await this.renderPage(name);
				} catch (e) {
					summaryBtn.textContent = t("wiki.distillSummary", lang);
					new Notice(t("wiki.summaryDistillFail", lang, { msg: e instanceof Error ? e.message : String(e) }));
				}
			});
		}
	}

	private openInEditor(name: string) {
		const page = this.findPage(name);
		if (page) {
			const wf = this.plugin.settings.wikiFolder;
			const fullPath = `${wf}/${page.path}`;
			const file = this.app.vault.getAbstractFileByPath(fullPath);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf(false).openFile(file);
				return;
			}
		}
		new Notice(t("wiki.pageNotFound", this.plugin.settings.language, { name }));
	}

	private findPage(name: string): WikiPage | undefined {
		return resolveWikiPageTarget(name, this.wikiPages);
	}

	/** 批量审核等场景：优先精确 path，再按链名解析 */
	private resolveWikiPage(target: string): WikiPage | undefined {
		return resolveWikiPageTarget(target, this.wikiPages);
	}

	private async markAsReviewed(target: string): Promise<void> {
		const page = this.resolveWikiPage(target);
		if (!page) return;
		const prevStatus = extractStatus(page.content) || "(none)";
		const shortName = page.path.split("/").pop()!.replace(/\.md$/i, "");
		const updated = setWikiFrontmatterStatus(page.content, "reviewed");
		const wf = this.plugin.settings.wikiFolder;
		const fullPath = `${wf}/${page.path}`;
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, updated);
			page.content = updated;
			const pageType = extractFmField(page.content, "type") || "unknown";
				const pageLevel = extractFmField(page.content, "level") || "";
				await writeLogEntry(this.app, wf, "sync", `Reviewed: [[${shortName}]]`,
					`- type: ${pageType}, level: ${pageLevel}\n- status: ${prevStatus} → reviewed`);
		}
	}

	private async markForRegeneration(target: string): Promise<void> {
		const page = this.resolveWikiPage(target);
		if (!page) return;
		const prevStatus = extractStatus(page.content) || "(none)";
		const shortName = page.path.split("/").pop()!.replace(/\.md$/i, "");
		const updated = setWikiFrontmatterStatus(page.content, "draft");
		const wf = this.plugin.settings.wikiFolder;
		const fullPath = `${wf}/${page.path}`;
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, updated);
			page.content = updated;
			new Notice(t("wiki.regeneratePageDone", this.plugin.settings.language));
				await writeLogEntry(this.app, wf, "sync", `Regenerate: [[${shortName}]]`,
					`- status: ${prevStatus} → draft`);
			try {
				await this.plugin.runWithCompileLock(() =>
					runCompile(this.app, this.plugin.settings, undefined, false, this.plugin as any),
				);
				await this.loadWiki();
				await this.renderPage(shortName);
			} catch (e) {
				console.warn("markForRegeneration: compile failed:", e);
			}
		}
	}

	private findBacklinks(name: string): Array<{ name: string; display: string }> {
		const results: Array<{ name: string; display: string }> = [];
		const searchPatterns = [`[[${name}]]`, `[[${name}|`, `[[${name}#`];

		for (const page of this.wikiPages) {
			if (page.path.split("/").pop()!.replace(".md", "") === name) continue;
			if (searchPatterns.some(p => page.content.includes(p))) {
				const fileName = page.path.split("/").pop()!.replace(".md", "");
				results.push({ name: fileName, display: fileName });
			}
		}
		return results;
	}

	async onClose() {
		this.component.unload();
		if (this.searchTimer) {
			clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}
		for (const el of this.wikiHeaderActionEls) el.remove();
		this.wikiHeaderActionEls = [];
	}
}

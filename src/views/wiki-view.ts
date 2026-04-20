// Wiki 预览视图 -- 结构化浏览 + 内联页面预览 + 反向链接

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Component, Notice, TFile, Modal, setIcon } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { runCompile } from "../core/compile";
import { openPluginSettings } from "../types";
import { readWikiFiles, writeLogEntry, vectorSearch } from "../core/file-utils";
import { computeWikiHealth } from "../core/health";
import { t } from "../core/i18n";

import { showMoc } from "./wiki-moc";
import { openSynthesisDialog } from "./wiki-synthesis";
import { toggleBatchReview } from "./wiki-batch";
import { setAsyncButton } from "../ui/async-button";
import type { WikiPage, IndexItem, IndexSection, WikiViewCtx } from "./wiki-shared";
import { extractFmField, extractTags, stripFrontmatter, extractStatus, extractUpdated, extractFmArray, extractExecutiveSummary } from "./wiki-shared";

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
	private sortMode: "name-asc" | "name-desc" | "type" | "level" | "recent" = "name-asc";
	private statusFilter: "all" | "draft" | "reviewed" = "all";
	private selectedPages = new Set<string>();
	private batchBar: HTMLElement | null = null;
	private pageLimit = 50;
	private searchTimer: ReturnType<typeof setTimeout> | null = null;
	private dropdownEl: HTMLElement | null = null;
	private dropdownCloseHandler: (() => void) | null = null;
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

		const toolbar = container.createDiv({ cls: "sb-wiki-toolbar" });

		const row1 = toolbar.createDiv({ cls: "sb-wiki-toolbar-row1" });
		row1.style.position = "relative";

		const toggle = row1.createDiv({ cls: "sb-wiki-view-toggle" });
		this.indexBtn = toggle.createEl("button", { text: t("wiki.tabIndex", lang), cls: "sb-wiki-view-btn active" });
		const mocBtn = toggle.createEl("button", { text: t("wiki.mocShort", lang), cls: "sb-wiki-view-btn" });
		this.indexBtn.addEventListener("click", () => this.showIndex());
		mocBtn.addEventListener("click", () => showMoc(this.ctx()));

		this.searchEl = row1.createEl("input", {
			attr: { placeholder: t("wiki.search", lang), type: "text", "aria-label": t("wiki.search", lang) },
			cls: "sb-wiki-search",
		});

		const filterDetails = row1.createEl("details", { cls: "sb-wiki-toolbar-filters" });
		const filterSummary = filterDetails.createEl("summary", { cls: "sb-wiki-toolbar-filters-summary" });
		setIcon(filterSummary.createSpan({ cls: "sb-wiki-toolbar-filters-icon" }), "sliders-horizontal");
		filterSummary.createSpan({ text: t("wiki.filtersSummary", lang), cls: "sb-wiki-toolbar-filters-text" });
		const filterBody = filterDetails.createDiv({ cls: "sb-wiki-toolbar-filters-body" });
		filterBody.createEl("label", { text: t("wiki.sortLabel", lang), cls: "sb-wiki-filter-label" });
		this.sortSelect = filterBody.createEl("select", { cls: "sb-wiki-sort" });
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
		filterBody.createEl("label", { text: t("wiki.statusLabel", lang), cls: "sb-wiki-filter-label" });
		this.statusSelect = filterBody.createEl("select", { cls: "sb-wiki-sort" });
		const statusOptions: Array<{ value: string; key: string }> = [
			{ value: "all", key: "wiki.filterAll" },
			{ value: "draft", key: "wiki.statusDraft" },
			{ value: "reviewed", key: "wiki.statusReviewed" },
		];
		for (const opt of statusOptions) {
			this.statusSelect.createEl("option", { text: t(opt.key, lang), attr: { value: opt.value } });
		}
		this.statusSelect.value = this.statusFilter;
		this.statusSelect.addEventListener("change", () => {
			this.statusFilter = this.statusSelect.value as typeof this.statusFilter;
			this.renderIndex();
		});

		const refreshBtn = row1.createEl("button", {
			attr: { "aria-label": t("wiki.refresh", lang), title: t("wiki.refresh", lang) },
			cls: "sb-wiki-refresh sb-wiki-icon-btn",
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.addEventListener("click", () => this.loadWiki());

		const moreBtn = row1.createEl("button", {
			attr: { "aria-label": t("wiki.moreMenu", lang), title: t("wiki.moreMenu", lang) },
			cls: "sb-wiki-more-btn sb-wiki-icon-btn",
		});
		setIcon(moreBtn, "more-vertical");

		this.dropdownEl = row1.createDiv({ cls: "sb-wiki-dropdown" });
		this.dropdownEl.style.display = "none";
		const synthItem = this.dropdownEl.createEl("button", { text: t("wiki.synthBtn", lang), cls: "sb-wiki-dropdown-item" });
		const batchItem = this.dropdownEl.createEl("button", { text: t("wiki.batchReview", lang), cls: "sb-wiki-dropdown-item" });

		moreBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (!this.dropdownEl) return;
			this.dropdownEl.style.display = this.dropdownEl.style.display === "none" ? "flex" : "none";
		});
		synthItem.addEventListener("click", () => {
			if (this.dropdownEl) this.dropdownEl.style.display = "none";
			openSynthesisDialog(this.ctx());
		});
		batchItem.addEventListener("click", () => {
			if (this.dropdownEl) this.dropdownEl.style.display = "none";
			const result = toggleBatchReview(this.ctx(), batchItem, this.batchBar, this.selectedPages);
			this.batchBar = result.batchBar;
		});
		this.dropdownCloseHandler = () => {
			if (this.dropdownEl) this.dropdownEl.style.display = "none";
		};
		document.addEventListener("click", this.dropdownCloseHandler);

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
		this.renderIndex();
	}

	private showIndex() {
		this.pageScrollTop.clear();
		this.currentView = "index";
		this.currentName = "";
		this.navHistory = [];
		this.indexBtn.classList.add("active");
		this.renderIndex();
	}

	// --- Index ---

	private parseIndex(content: string): IndexSection[] {
		const sections: IndexSection[] = [];
		let cur: IndexSection | null = null;
		let sub: { title: string; items: IndexItem[] } | null = null;

		for (const line of content.split("\n")) {
			const h2 = line.match(/^## (.+)/);
			const h3 = line.match(/^### (.+)/);
			const item = line.match(/^- \[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*(?:\u2014\s*)?(.*)/);

			if (h2) {
				cur = { title: h2[1], subs: [] };
				sections.push(cur);
				sub = null;
			} else if (h3 && cur) {
				sub = { title: h3[1], items: [] };
				cur.subs.push(sub);
			} else if (item) {
				const entry: IndexItem = { name: item[1], display: item[2] || item[1], desc: item[3] || "" };
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
			const ps = extractStatus(page.content);
			if (ps === "draft") meta.createEl("span", { cls: "sb-wiki-list-status sb-wiki-list-status-draft", text: t("wiki.statusDraft", lang) });
			else if (ps === "reviewed") meta.createEl("span", { cls: "sb-wiki-list-status sb-wiki-list-status-reviewed", text: t("wiki.statusReviewed", lang) });
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
		const sampleFolder = this.app.vault.getAbstractFileByPath("raw-sample");
		const rawFolder = this.plugin.settings.rawFolder;
		const rawDir = this.app.vault.getAbstractFileByPath(rawFolder);
		let rawHasFiles = false;
		if (rawDir) {
			const allFiles = this.app.vault.getFiles();
			rawHasFiles = allFiles.some(f => f.path.startsWith(rawFolder + "/") && !f.path.includes("_usage"));
		}
		if (!rawHasFiles && sampleFolder) {
			const sampleBtn = guidance.createEl("button", { text: t("empty.loadSamples", lang), cls: "sb-empty-btn" });
			sampleBtn.style.marginBottom = "8px";
			sampleBtn.addEventListener("click", async () => {
				sampleBtn.textContent = "...";
				try {
					const files = this.app.vault.getFiles().filter(f => f.path.startsWith("raw-sample/"));
					for (const f of files) {
						const targetPath = f.path.replace("raw-sample/", rawFolder + "/");
						const existing = this.app.vault.getAbstractFileByPath(targetPath);
						if (!existing) {
							const fileContent = await this.app.vault.read(f);
							const folderPath = targetPath.substring(0, targetPath.lastIndexOf("/"));
							const folder = this.app.vault.getAbstractFileByPath(folderPath);
							if (!folder) {
								const parts = folderPath.split("/");
								let cur = "";
								for (const p of parts) {
									cur = cur ? cur + "/" + p : p;
									if (!this.app.vault.getAbstractFileByPath(cur)) {
										await this.app.vault.createFolder(cur);
									}
								}
							}
							await this.app.vault.create(targetPath, fileContent);
						}
					}
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

	private renderIndex() {
		const query = (this.searchEl?.value || "").toLowerCase();
		const lang = this.plugin.settings.language;
		const indexGen = ++this.indexRenderGeneration;
		if (this.sortSelect) this.sortSelect.value = this.sortMode;
		if (this.statusSelect) this.statusSelect.value = this.statusFilter;
		this.bodyEl.empty();

		if (this.wikiPages.length === 0) {
			this.renderWikiEmpty(lang);
			return;
		}

		if (!query) {
			const cc = this.wikiPages.filter(f => f.path.includes("concepts/")).length;
			const ec = this.wikiPages.filter(f => f.path.includes("entities/")).length;
			const sc = this.wikiPages.filter(f => f.path.includes("sources/")).length;
			const health = this.wikiPages.length > 0 ? computeWikiHealth(this.wikiPages) : null;
			const totalPages = health?.total ?? this.wikiPages.length;
			const reviewedCount = health?.reviewed ?? 0;
			const draftCount = totalPages - reviewedCount;

			// 紧凑概览：一行核心指标，点击展开
			const overviewToggle = this.bodyEl.createDiv({ cls: "sb-wiki-overview-toggle" });
			const statItems: Array<{ num: string; label: string; cls?: string }> = [
					{ num: String(totalPages), label: t("wiki.growthTotalPages", lang) },
					{ num: String(cc), label: t("wiki.concepts", lang) },
					{ num: String(ec), label: t("wiki.entities", lang) },
					{ num: String(sc), label: t("wiki.sources", lang) },
					{ num: String(reviewedCount), label: t("wiki.statusReviewed", lang), cls: "sb-growth-reviewed" },
					{ num: String(draftCount), label: t("wiki.statusDraft", lang), cls: "sb-growth-draft" },
				];
				for (const item of statItems) {
					const span = overviewToggle.createEl("span", { cls: "sb-stat-item" });
					span.createEl("span", { text: item.num, cls: "sb-stat-num" + (item.cls ? " " + item.cls : "") });
					span.createEl("span", { text: item.label, cls: "sb-stat-label" });
				}

			const overviewDetail = this.bodyEl.createDiv({ cls: "sb-wiki-overview-detail" });
			overviewDetail.style.display = "none";

			if (health) {
				const reviewPct = totalPages > 0 ? Math.round((reviewedCount / totalPages) * 100) : 0;
				const progressWrap = overviewDetail.createDiv({ cls: "sb-growth-progress-wrap" });
					progressWrap.createEl("span", { text: t("wiki.growthReviewProgress", lang, { pct: reviewPct }), cls: "sb-growth-label" });
					const progressBar = progressWrap.createDiv({ cls: "sb-growth-progress-bar" });
					progressBar.createDiv({ cls: "sb-growth-progress-fill", attr: { style: `width:${reviewPct}%` } });

				const freshPct = 100 - health.staleness;
				const barColor = freshPct >= 70 ? "var(--text-success)" : freshPct >= 40 ? "var(--text-warning)" : "var(--text-error)";
				const healthRow = overviewDetail.createDiv({ cls: "sb-health-row" });
				const barWrap = healthRow.createDiv({ cls: "sb-health-bar" });
				barWrap.createDiv({ cls: "sb-health-fill", attr: { style: `width:${freshPct}%;background:${barColor}` } });
				const healthStats = healthRow.createDiv({ cls: "sb-health-stats" });
				healthStats.createEl("span", { cls: "sb-health-badge", text: `${freshPct}%` });
				healthStats.createEl("span", { cls: "sb-health-label", text: t("health.healthBar", lang) });
				healthStats.createEl("span", { cls: "sb-health-sep", text: "|" });
				healthStats.createEl("span", { cls: "sb-health-badge", text: String(health.avgLinkCount) });
				healthStats.createEl("span", { cls: "sb-health-label", text: t("health.avgLinks", lang) });
				healthStats.createEl("span", { cls: "sb-health-sep", text: "|" });
				healthStats.createEl("span", { cls: "sb-health-badge", text: `${reviewedCount}/${totalPages}` });
				healthStats.createEl("span", { cls: "sb-health-label", text: t("health.reviewProgress", lang, { reviewed: String(reviewedCount), total: String(totalPages) }) });

				if (health.stalePages.length > 0) {
					const staleToggle = overviewDetail.createDiv({ cls: "sb-health-stale-toggle" });
					staleToggle.createEl("span", { text: t("health.stalePages", lang) + ` (${health.stalePages.length})`, cls: "sb-health-stale-label" });
					const toggleIcon = staleToggle.createEl("span", { text: "▸", cls: "sb-health-toggle-icon" });
					const staleList = overviewDetail.createDiv({ cls: "sb-health-stale-list" });
					staleList.style.display = "none";
					for (const sp of health.stalePages) {
						const row = staleList.createDiv({ cls: "sb-health-stale-row" });
						row.createEl("a", { text: sp.name, cls: "sb-health-stale-name" })
							.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(sp.name); });
						row.createEl("span", { text: t("health.daysAgo", lang, { n: sp.daysSinceUpdate }), cls: "sb-health-stale-days" });
						if (sp.level) row.createEl("span", { text: sp.level, cls: "sb-health-stale-level" });
					}
					staleToggle.addEventListener("click", () => {
						const open = staleList.style.display !== "none";
						staleList.style.display = open ? "none" : "";
						toggleIcon.textContent = open ? "▸" : "▾";
					});
				}
			}

			overviewToggle.addEventListener("click", () => {
				const open = overviewDetail.style.display !== "none";
				overviewDetail.style.display = open ? "none" : "";
				overviewToggle.classList.toggle("sb-overview-expanded", !open);
			});

		} else {
			const matchCount = this.wikiPages.filter(f => {
				const name = f.path.split("/").pop()!.replace(".md", "");
				if (name === "index" || name === "log") return false;
				return name.toLowerCase().includes(query) || f.content.toLowerCase().includes(query);
			}).length;
			this.bodyEl.createEl("p", { text: t("wiki.searchResultsCount", lang, { n: String(matchCount) }), cls: "sb-wiki-search-hint" });
		}

// 统一页面列表：合并 index 条目和非 index 页面
			const indexNames = new Set<string>();
			for (const sec of this.indexData)
				for (const sub of sec.subs)
					for (const i of sub.items) indexNames.add(i.name);

			const entries: WikiIndexEntry[] = [];

			// index 条目
			for (const sec of this.indexData) {
				for (const sub of sec.subs) {
					for (const item of sub.items) {
						entries.push({ name: item.name, display: item.display, desc: item.desc || "", section: sec.title, subSection: sub.title });
					}
				}
			}

			// 不在 index 中的页面
			for (const f of this.wikiPages) {
				const name = f.path.split("/").pop()!.replace(".md", "");
				if (name === "index" || name === "log") continue;
				if (indexNames.has(name)) continue;
				const fmTitle = f.content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
				const stripped = f.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
				const firstLine = stripped.split("\n").find((l: string) => l.trim() && !l.startsWith("#") && !l.startsWith(">")) || "";
				entries.push({ name, display: fmTitle ? fmTitle[1] : name, desc: firstLine.slice(0, 120), section: "", subSection: "" });
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
					const s = extractStatus(page.content);
					return this.statusFilter === "draft" ? s !== "reviewed" : s === "reviewed";
				});
			}

			const sorted = this.sortPageEntries(filtered);
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

		const pageStatus = extractStatus(page.content);
		if (pageStatus === "gap") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			banner.createEl("span", { text: t("wiki.gap", lang), cls: "sb-draft-label" });
			const regenBtn = banner.createEl("button", { text: t("wiki.regeneratePage", lang), cls: "sb-draft-review-btn" });
			regenBtn.addEventListener("click", async () => {
				await this.markForRegeneration(name);
					regenBtn.textContent = t("wiki.regeneratePageDone", lang);
				regenBtn.setAttribute("disabled", "true");
			});
		} else if (pageStatus === "outdated") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			banner.createEl("span", { text: t("wiki.outdated", lang), cls: "sb-draft-label" });
			const regenBtn = banner.createEl("button", { text: t("wiki.regeneratePage", lang), cls: "sb-draft-review-btn" });
			regenBtn.addEventListener("click", async () => {
				await this.markForRegeneration(name);
					regenBtn.textContent = t("wiki.regeneratePageDone", lang);
				regenBtn.setAttribute("disabled", "true");
			});
		} else if (pageStatus === "draft") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			banner.createEl("span", { text: t("wiki.draft", lang), cls: "sb-draft-label" });
			const reviewBtn = banner.createEl("button", { text: t("wiki.markReviewed", lang), cls: "sb-draft-review-btn" });
			reviewBtn.addEventListener("click", async () => {
					await this.markAsReviewed(name);
					await this.renderPage(name);
				});
		} else if (pageStatus === "reviewed") {
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
		return this.wikiPages.find(f => {
			const fileName = f.path.split("/").pop()!.replace(".md", "");
			return fileName === name || f.path === name || f.path === name + ".md";
		});
	}

	private async markAsReviewed(name: string): Promise<void> {
		const page = this.findPage(name);
		if (!page) return;
		const updated = page.content.replace(/^status:\s*["']?\w+["']?\s*$/m, 'status: "reviewed"');
		const wf = this.plugin.settings.wikiFolder;
		const fullPath = `${wf}/${page.path}`;
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, updated);
			page.content = updated;
			const pageType = extractFmField(page.content, "type") || "unknown";
				const pageLevel = extractFmField(page.content, "level") || "";
				await writeLogEntry(this.app, wf, "sync", `Reviewed: [[${name}]]`,
					`- type: ${pageType}, level: ${pageLevel}\n- status: draft → reviewed`);
		}
	}

	private async markForRegeneration(name: string): Promise<void> {
		const page = this.findPage(name);
		if (!page) return;
		const updated = page.content.replace(/^status:\s*["']?\w+["']?\s*$/m, 'status: "draft"');
		const wf = this.plugin.settings.wikiFolder;
		const fullPath = `${wf}/${page.path}`;
		const file = this.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof TFile) {
			await this.app.vault.modify(file, updated);
			page.content = updated;
			new Notice(t("wiki.regeneratePageDone", this.plugin.settings.language));
				const prevStatus = extractFmField(page.content, "status") || "unknown";
				await writeLogEntry(this.app, wf, "sync", `Regenerate: [[${name}]]`,
					`- status: ${prevStatus} → draft`);
			try {
				await this.plugin.runWithCompileLock(() =>
					runCompile(this.app, this.plugin.settings, undefined, false, this.plugin as any),
				);
				await this.loadWiki();
				this.renderPage(name);
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
		if (this.dropdownCloseHandler) {
			document.removeEventListener("click", this.dropdownCloseHandler);
			this.dropdownCloseHandler = null;
		}
	}
}

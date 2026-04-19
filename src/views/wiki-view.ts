// Wiki 预览视图 -- 结构化浏览 + 内联页面预览 + 反向链接

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Component, Notice, TFile, Modal } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { openPluginSettings } from "../types";
import { readWikiFiles, writeLogEntry } from "../core/file-utils";
import { computeWikiHealth } from "../core/health";
import { scanVaultForMaterials, importToRaw } from "../core/vault-scanner";
import { t } from "../core/i18n";
import { requirePro, showUpgradeNotice, createProBadge } from "../core/feature-gate";
import { renderGraph } from "./wiki-mindmap";
import { showMoc } from "./wiki-moc";
import { openSynthesisDialog } from "./wiki-synthesis";
import { toggleBatchReview } from "./wiki-batch";
import { setAsyncButton } from "../ui/async-button";
import type { WikiPage, IndexItem, IndexSection, WikiViewCtx } from "./wiki-shared";
import { extractFmField, extractTags, stripFrontmatter, extractStatus, extractUpdated, extractFmArray } from "./wiki-shared";

export const VIEW_TYPE_WIKI = "second-brain-wiki";

export class WikiView extends ItemView {
	plugin: SecondBrainPlugin;
	private bodyEl: HTMLElement;
	private searchEl: HTMLInputElement;
	private sortSelect: HTMLSelectElement;
	private wikiPages: WikiPage[] = [];
	private indexData: IndexSection[] = [];
	private currentView: "index" | "page" | "graph" = "index";
	private currentName = "";
	private navHistory: string[] = [];
	private component: Component;
	private graphMode = false;
	private indexBtn: HTMLButtonElement;
	private graphBtn: HTMLButtonElement;
	private sortMode: "name-asc" | "name-desc" | "type" | "level" | "recent" = "name-asc";
	private batchMode = false;
	private selectedPages = new Set<string>();
	private batchBar: HTMLElement | null = null;
	private pageLimit = 50;
	private searchTimer: ReturnType<typeof setTimeout> | null = null;
	private dropdownEl: HTMLElement | null = null;

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

		// Row 1: view toggle + search + refresh
		const row1 = toolbar.createDiv({ cls: "sb-wiki-toolbar-row1" });

		const toggle = row1.createDiv({ cls: "sb-wiki-view-toggle" });
		this.indexBtn = toggle.createEl("button", { text: t("wiki.tabIndex", lang), cls: "sb-wiki-view-btn active" });
		const mocBtn = toggle.createEl("button", { text: "MOC", cls: "sb-wiki-view-btn" });
		this.graphBtn = toggle.createEl("button", { text: t("wiki.tabGraph", lang), cls: "sb-wiki-view-btn" });
		if (!requirePro(this.plugin.licenseInfo, "svg-mind-map")) {
			createProBadge(this.graphBtn, lang);
			this.graphBtn.classList.add("sb-pro-locked-btn");
		}
		this.indexBtn.addEventListener("click", () => this.showIndex());
		mocBtn.addEventListener("click", () => showMoc(this.ctx()));
		this.graphBtn.addEventListener("click", () => this.showGraph());

		this.searchEl = row1.createEl("input", {
			attr: { placeholder: t("wiki.search", lang), type: "text" },
			cls: "sb-wiki-search",
		});

		const refreshBtn = row1.createEl("button", { text: t("wiki.refresh", lang), cls: "sb-wiki-refresh" });
		refreshBtn.addEventListener("click", () => this.loadWiki());

		// Row 2: sort + more dropdown (synth + batch)
		const row2 = toolbar.createDiv({ cls: "sb-wiki-toolbar-row2" });
		row2.style.position = "relative";

		this.sortSelect = row2.createEl("select", { cls: "sb-wiki-sort" });
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
		this.sortSelect.addEventListener("change", () => {
			this.sortMode = this.sortSelect.value as typeof this.sortMode;
			this.renderIndex();
		});

			const moreBtn = row2.createEl("button", { text: "...", cls: "sb-wiki-more-btn" });
		this.dropdownEl = row2.createDiv({ cls: "sb-wiki-dropdown" });
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
			this.batchMode = result.batchMode;
			this.batchBar = result.batchBar;
		});
		document.addEventListener("click", () => {
			if (this.dropdownEl) this.dropdownEl.style.display = "none";
		});

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
			graphMode: this.graphMode,
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
		};
	}

	async loadWiki() {
		const wf = this.plugin.settings.wikiFolder;
		this.wikiPages = await readWikiFiles(this.app, wf);

		const idx = this.wikiPages.find(f => f.path === "index.md" || f.path.endsWith("/index.md"));
		this.indexData = this.parseIndex(idx ? idx.content : "");

		this.currentName = "";
		this.navHistory = [];

		if (this.graphMode) {
			this.currentView = "graph";
			renderGraph(this, this.bodyEl, this.wikiPages, (id: string) => this.navigateTo(id), this.plugin.settings.language);
		} else {
			this.currentView = "index";
			this.renderIndex();
		}
	}

	private showIndex() {
		this.graphMode = false;
		this.currentView = "index";
		this.currentName = "";
		this.navHistory = [];
		this.indexBtn.classList.add("active");
		this.graphBtn.classList.remove("active");
		this.renderIndex();
	}

	private showGraph() {
		if (!requirePro(this.plugin.licenseInfo, "svg-mind-map")) {
			showUpgradeNotice(this.app, "svg-mind-map", this.plugin.settings.language);
			return;
		}
		this.graphMode = true;
		this.currentView = "graph";
		this.currentName = "";
		this.navHistory = [];
		this.indexBtn.classList.remove("active");
		this.graphBtn.classList.add("active");
		renderGraph(this, this.bodyEl, this.wikiPages, (id: string) => this.navigateTo(id), this.plugin.settings.language);
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

	private sortItems(items: IndexItem[]): IndexItem[] {
		const sorted = [...items];
		sorted.sort((a, b) => {
			switch (this.sortMode) {
				case "name-asc":
					return a.display.localeCompare(b.display);
				case "name-desc":
					return b.display.localeCompare(a.display);
				case "type": {
					const typeA = this.findPage(a.name) ? extractFmField(this.findPage(a.name)!.content, "type") : "";
					const typeB = this.findPage(b.name) ? extractFmField(this.findPage(b.name)!.content, "type") : "";
					return typeA.localeCompare(typeB) || a.display.localeCompare(b.display);
				}
				case "level": {
					const levelA = this.findPage(a.name) ? extractFmField(this.findPage(a.name)!.content, "level") : "";
					const levelB = this.findPage(b.name) ? extractFmField(this.findPage(b.name)!.content, "level") : "";
					return levelA.localeCompare(levelB) || a.display.localeCompare(b.display);
				}
				default:
					return 0;
			}
		});
		return sorted;
	}

	private renderIndex() {
		const query = (this.searchEl?.value || "").toLowerCase();
		const lang = this.plugin.settings.language;
		this.bodyEl.empty();

		const cc = this.wikiPages.filter(f => f.path.includes("concepts/")).length;
		const ec = this.wikiPages.filter(f => f.path.includes("entities/")).length;
		const sc = this.wikiPages.filter(f => f.path.includes("sources/")).length;

		const stats = this.bodyEl.createDiv({ cls: "sb-wiki-stats" });
		stats.innerHTML =
			`<span class="sb-stat-item"><span class="sb-stat-num">${cc}</span><span class="sb-stat-label">${t("wiki.concepts", lang)}</span></span>` +
			`<span class="sb-stat-item"><span class="sb-stat-num">${ec}</span><span class="sb-stat-label">${t("wiki.entities", lang)}</span></span>` +
			`<span class="sb-stat-item"><span class="sb-stat-num">${sc}</span><span class="sb-stat-label">${t("wiki.sources", lang)}</span></span>`;

		if (requirePro(this.plugin.licenseInfo, "svg-mind-map")) {
			const linkCount = this.wikiPages.reduce((sum, p) => {
				const matches = p.content.match(/\[\[([^\]]+)\]\]/g);
				return sum + (matches ? matches.length : 0);
			}, 0);
			stats.innerHTML += `<span class="sb-stat-item sb-stat-pro"><span class="sb-stat-num">${linkCount}</span><span class="sb-stat-label">${t("pro.stats.linkLabel", lang)}</span></span>`;
		}

		// Feature 5: Knowledge growth stats panel
		const draftCount = this.wikiPages.filter(f => extractStatus(f.content) === "draft").length;
		const reviewedCount = this.wikiPages.filter(f => extractStatus(f.content) === "reviewed").length;
		const totalPages = this.wikiPages.length;
		const reviewPct = totalPages > 0 ? Math.round((reviewedCount / totalPages) * 100) : 0;
		const growthPanel = this.bodyEl.createDiv({ cls: "sb-wiki-growth-panel" });
		growthPanel.innerHTML =
			`<div class="sb-growth-stat"><span class="sb-growth-num">${totalPages}</span><span class="sb-growth-label">${t("wiki.growthTotalPages", lang)}</span></div>` +
			`<div class="sb-growth-stat"><span class="sb-growth-num sb-growth-draft">${draftCount}</span><span class="sb-growth-label">${t("wiki.growthDraftPages", lang)}</span></div>` +
			`<div class="sb-growth-stat"><span class="sb-growth-num sb-growth-reviewed">${reviewedCount}</span><span class="sb-growth-label">${t("wiki.growthReviewedPages", lang)}</span></div>` +
			`<div class="sb-growth-progress-wrap"><span class="sb-growth-label">${t("wiki.growthReviewProgress", lang, { pct: reviewPct })}</span><div class="sb-growth-progress-bar"><div class="sb-growth-progress-fill" style="width:${reviewPct}%"></div></div></div>`;

		// Health dashboard
		if (this.wikiPages.length > 0) {
			const health = computeWikiHealth(this.wikiPages);
			const healthEl = this.bodyEl.createDiv({ cls: "sb-health" });
			const healthRow = healthEl.createDiv({ cls: "sb-health-row" });

			const barWrap = healthRow.createDiv({ cls: "sb-health-bar" });
			const freshPct = 100 - health.staleness;
			const barColor = freshPct >= 70 ? "var(--text-success)" : freshPct >= 40 ? "var(--text-warning)" : "var(--text-error)";
			barWrap.createDiv({ cls: "sb-health-fill", attr: { style: `width:${freshPct}%;background:${barColor}` } });

			const healthStats = healthRow.createDiv({ cls: "sb-health-stats" });
			healthStats.createEl("span", { cls: "sb-health-badge", text: `${freshPct}%` });
			healthStats.createEl("span", { cls: "sb-health-label", text: t("health.healthBar", lang) });
			healthStats.createEl("span", { cls: "sb-health-sep", text: "|" });
			healthStats.createEl("span", { cls: "sb-health-badge", text: String(health.avgLinkCount) });
			healthStats.createEl("span", { cls: "sb-health-label", text: t("health.avgLinks", lang) });
			healthStats.createEl("span", { cls: "sb-health-sep", text: "|" });
			healthStats.createEl("span", { cls: "sb-health-badge", text: `${health.reviewed}/${health.total}` });
			healthStats.createEl("span", { cls: "sb-health-label", text: t("health.reviewProgress", lang, { reviewed: String(health.reviewed), total: String(health.total) }) });

			if (health.stalePages.length > 0) {
				const staleToggle = healthEl.createDiv({ cls: "sb-health-stale-toggle" });
				staleToggle.createEl("span", { text: t("health.stalePages", lang) + ` (${health.stalePages.length})`, cls: "sb-health-stale-label" });
				const toggleIcon = staleToggle.createEl("span", { text: "▸", cls: "sb-health-toggle-icon" });
				const staleList = healthEl.createDiv({ cls: "sb-health-stale-list" });
				staleList.style.display = "none";
				for (const sp of health.stalePages) {
					const row = staleList.createDiv({ cls: "sb-health-stale-row" });
					const nameLink = row.createEl("a", { text: sp.name, cls: "sb-health-stale-name" });
					nameLink.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(sp.name); });
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

		const recentPages = this.wikiPages
			.map(f => ({ name: f.path.split("/").pop()!.replace(".md", ""), date: extractUpdated(f.content) }))
			.filter(f => f.date)
			.sort((a, b) => b.date.localeCompare(a.date))
			.slice(0, 8);
		if (recentPages.length > 0) {
			this.bodyEl.createEl("h3", { text: t("wiki.recentUpdates", lang), cls: "sb-wiki-h3" });
			const recentGrid = this.bodyEl.createDiv({ cls: "sb-wiki-grid" });
			for (const rp of recentPages) {
				const card = recentGrid.createDiv({ cls: "sb-wiki-card" });
				card.createEl("a", { text: rp.name, cls: "sb-wiki-card-title" })
					.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(rp.name); });
				card.createEl("span", { text: rp.date, cls: "sb-wiki-card-date" });
				const page = this.findPage(rp.name);
				if (page) {
					const lines = page.content.split("\n");
					const desc = lines.find(l => l.trim() && !l.startsWith("---") && !l.startsWith("#") && !l.startsWith("title:") && !l.startsWith("type:") && !l.startsWith("tags:"));
					if (desc) card.createEl("p", { text: desc.slice(0, 80), cls: "sb-wiki-card-desc" });
				}
			}
		}

		for (const sec of this.indexData) {
			let hasTitle = false;
			for (const sub of sec.subs) {
				let items = sub.items;
				if (query) {
					items = items.filter(i =>
						i.name.toLowerCase().includes(query) ||
						i.display.toLowerCase().includes(query) ||
						(i.desc || "").toLowerCase().includes(query)
					);
				}
				if (query && items.length === 0) continue;

				items = this.sortItems(items);

				if (!hasTitle) {
					this.bodyEl.createEl("h2", { text: sec.title, cls: "sb-wiki-h2" });
					hasTitle = true;
				}
				if (sub.title) {
					this.bodyEl.createEl("h3", { text: sub.title, cls: "sb-wiki-h3" });
				}

				const grid = this.bodyEl.createDiv({ cls: "sb-wiki-grid" });
				for (const item of items) {
					const card = grid.createDiv({ cls: "sb-wiki-card" });
					const page = this.findPage(item.name);
					const pageTags = page ? extractTags(page.content) : [];

					if (page) {
						const pageStatus = extractStatus(page.content);
						if (pageStatus === "draft") {
							card.classList.add("sb-wiki-card-draft");
							card.createEl("span", { text: t("wiki.statusDraft", lang), cls: "sb-wiki-status-badge sb-status-draft" });
						} else if (pageStatus === "reviewed") {
							card.classList.add("sb-wiki-card-reviewed");
							card.createEl("span", { text: t("wiki.statusReviewed", lang), cls: "sb-wiki-status-badge sb-status-reviewed" });
						}
					}

					card.createEl("a", { text: item.display, cls: "sb-wiki-card-title" })
						.addEventListener("click", (ev) => {
							ev.preventDefault();
							this.navigateTo(item.name);
						});

					if (item.desc) {
						card.createEl("p", { text: item.desc, cls: "sb-wiki-card-desc" });
					}

					if (pageTags.length > 0) {
						const tagRow = card.createDiv({ cls: "sb-wiki-card-tags" });
						for (const tag of pageTags.slice(0, 3)) {
							tagRow.createEl("span", { text: tag, cls: "sb-wiki-tag" });
						}
					}
				}
			}
		}

		if (query) {
			const seen = new Set<string>();
			for (const sec of this.indexData)
				for (const sub of sec.subs)
					for (const i of sub.items) seen.add(i.name);

			const extra = this.wikiPages.filter(f => {
				const name = f.path.split("/").pop()!.replace(".md", "");
				if (seen.has(name)) return false;
				return name.toLowerCase().includes(query) || f.content.slice(0, 500).toLowerCase().includes(query);
			});

			if (extra.length > 0) {
				this.bodyEl.createEl("h3", { text: t("wiki.otherMatches", lang), cls: "sb-wiki-h3" });
				const grid = this.bodyEl.createDiv({ cls: "sb-wiki-grid" });
				for (const f of extra.slice(0, 20)) {
					const name = f.path.split("/").pop()!.replace(".md", "");
					const card = grid.createDiv({ cls: "sb-wiki-card" });
					card.createEl("a", { text: name, cls: "sb-wiki-card-title" })
						.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(name); });
					card.createEl("p", { text: f.path.replace(/\.md$/, ""), cls: "sb-wiki-card-desc" });
				}
			}
		}

		if (this.wikiPages.length === 0) {
			this.bodyEl.createDiv({ cls: "sb-wiki-empty" });
			const guidance = this.bodyEl.createDiv({ cls: "sb-wiki-empty-guidance" });
			guidance.createEl("h3", { text: t("empty.wikiTitle", lang) });

			// 3-step guide
			const steps = guidance.createDiv({ cls: "sb-empty-steps" });
			const step1 = steps.createDiv({ cls: "sb-empty-step" });
			step1.createEl("span", { text: "1", cls: "sb-empty-step-num" });
			step1.createEl("span", { text: t("empty.step1Put", lang), cls: "sb-empty-step-text" });

			// Detect if raw-sample exists and raw is empty
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

		if (this.wikiPages.length > this.pageLimit) {
			const loadMoreBtn = this.bodyEl.createEl("button", {
				text: t("wiki.loadMore", lang, { n: this.wikiPages.length - this.pageLimit }),
				cls: "sb-wiki-load-more"
			});
			loadMoreBtn.addEventListener("click", () => {
				this.pageLimit += 50;
				this.renderIndex();
			});
		}
	}

	// --- Page ---

	private async navigateTo(name: string) {
		const marker = this.currentView === "graph" ? "__graph__" : this.currentName;
		this.navHistory.push(marker);
		this.currentName = name;
		this.currentView = "page";
		await this.renderPage(name);
	}

	private async goBack() {
		const prev = this.navHistory.pop();
		if (!prev || prev === "") {
			if (this.graphMode) this.showGraph();
			else this.showIndex();
			return;
		}
		if (prev === "__graph__") {
			this.currentView = "graph";
			this.indexBtn.classList.remove("active");
			this.graphBtn.classList.add("active");
			renderGraph(this, this.bodyEl, this.wikiPages, (id: string) => this.navigateTo(id), this.plugin.settings.language);
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
		breadcrumb.createEl("button", { text: t("wiki.back", lang), cls: "sb-wiki-back" })
			.addEventListener("click", () => this.goBack());
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
		if (pageStatus === "draft") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			banner.createEl("span", { text: t("wiki.draft", lang), cls: "sb-draft-label" });
			const reviewBtn = banner.createEl("button", { text: t("wiki.markReviewed", lang), cls: "sb-draft-review-btn" });
			reviewBtn.addEventListener("click", async () => {
				await this.markAsReviewed(name);
				reviewBtn.textContent = t("wiki.reviewed", lang);
				banner.classList.replace("sb-draft-banner", "sb-reviewed-banner");
				const label = banner.querySelector(".sb-draft-label");
				if (label) label.textContent = t("wiki.reviewed", lang);
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
				} catch (e) {
					summaryBtn.textContent = t("wiki.distillSummary", lang);
				}
			});
		}

		const contentEl = this.bodyEl.createDiv({ cls: "sb-wiki-page-content" });
		const stripped = stripFrontmatter(page.content);
		this.component.unload();
		this.component = new Component();
		await MarkdownRenderer.render(this.app, stripped, contentEl, "", this.component);

		contentEl.querySelectorAll("a.internal-link").forEach((link: HTMLAnchorElement) => {
			const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
			const targetName = href.split("/").pop()!.replace(".md", "").split("|")[0].split("#")[0];
			link.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				this.navigateTo(targetName);
			});
		});

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


	private addRegenerateButtons(contentEl: HTMLElement, page: WikiPage, pageName: string) {
		const lang = this.plugin.settings.language;
		const headings = contentEl.querySelectorAll("h2, h3");
		for (const heading of headings) {
			const sectionTitle = heading.textContent || "";
			const regenBtn = createEl("button", {
				cls: "sb-wiki-regen-btn",
				text: t("wiki.regenerateSection", lang),
			});
			regenBtn.style.display = "none";
			(heading as HTMLElement).style.position = "relative";
			(heading as HTMLElement).appendChild(regenBtn);

			(heading as HTMLElement).addEventListener("mouseenter", () => {
				regenBtn.style.display = "";
			});
			(heading as HTMLElement).addEventListener("mouseleave", () => {
				regenBtn.style.display = "none";
			});

			regenBtn.addEventListener("click", async (ev) => {
				ev.preventDefault();
				ev.stopPropagation();

				const confirmed = await new Promise<boolean>((resolve) => {
					const modal = new Modal(this.app);
					modal.titleEl.setText(t("wiki.regenerateSection", lang));
					modal.contentEl.createEl("p", { text: t("wiki.regenerateConfirm", lang, { section: sectionTitle }) });
					const btnRow = modal.contentEl.createDiv();
					btnRow.style.display = "flex";
					btnRow.style.gap = "8px";
					btnRow.style.justifyContent = "flex-end";
					btnRow.createEl("button", { text: t("set.cancel", lang) }).addEventListener("click", () => { modal.close(); resolve(false); });
					btnRow.createEl("button", { text: t("wiki.regenerateSection", lang), cls: "mod-cta" }).addEventListener("click", () => { modal.close(); resolve(true); });
					modal.open();
				});
				if (!confirmed) return;

				setAsyncButton(regenBtn, true, t("wiki.regenerating", lang));
				try {
					const { callLLM } = await import("../core/llm");
					const strippedContent = stripFrontmatter(page.content);
					const result = await callLLM([
						{ role: "system", content: "Knowledge regenerator. Rewrite the specified section with improved clarity and depth. Same language as source. Keep wikilinks [[PageName]]." },
						{ role: "user", content: `Rewrite the section "${sectionTitle}" from this wiki page. Only return the new section content (starting with ## ${sectionTitle}):

${strippedContent.slice(0, 6000)}` },
					], this.plugin.settings, { maxTokens: 2000, temperature: 0.4 });

					// Find and replace the section in page content
					const newSection = result.trim();
					const stripped2 = stripFrontmatter(page.content);
					const sectionRegex = new RegExp(`(##\\s*${sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.+?)(?=\n##\\s|\n###[^#]|$)`, "s");
					const updated = stripped2.replace(sectionRegex, newSection);
					const fm = page.content.match(/^---\n[\s\S]*?\n---/)?.[0] || "";
					const fullUpdated = fm + "\n\n" + updated;
					const wf = this.plugin.settings.wikiFolder;
					const fullPath = `${wf}/${page.path}`;
					const file = this.app.vault.getAbstractFileByPath(fullPath);
					if (file instanceof TFile) {
						await this.app.vault.modify(file, fullUpdated);
						page.content = fullUpdated;
					}
					setAsyncButton(regenBtn, false, t("wiki.regenerateDone", lang));
				} catch (e) {
					setAsyncButton(regenBtn, false, t("wiki.regenerateFail", lang));
					new Notice(t("wiki.regenerateFail", lang));
				}
			});
		}
	}

	private openInEditor(name: string) {
		const wf = this.plugin.settings.wikiFolder;
		const paths = [
			`${wf}/${name}.md`,
			`${wf}/concepts/核心概念/${name}.md`,
			`${wf}/concepts/方法框架/${name}.md`,
			`${wf}/concepts/实践经验/${name}.md`,
			`${wf}/entities/${name}.md`,
			`${wf}/sources/${name}.md`,
		];
		for (const p of paths) {
			const file = this.app.vault.getAbstractFileByPath(p);
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
			await writeLogEntry(this.app, wf, "sync", `Reviewed: ${name}`);
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
	}
}

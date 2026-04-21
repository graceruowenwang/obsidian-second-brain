// Wiki 预览视图 -- 结构化浏览 + 内联页面预览 + 反向链接
// 生命周期、状态管理和委托层

import { ItemView, WorkspaceLeaf, Component, Menu } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { scanWikiFiles, readWikiPage } from "../core/file-utils";
import { t } from "../core/i18n";

import { showMoc } from "./wiki-moc";
import { openSynthesisDialog } from "./wiki-synthesis";
import { toggleBatchReview } from "./wiki-batch";
import type { WikiPage, IndexSection, WikiViewCtx } from "./wiki-shared";
import { extractFmField, extractTags, resolveWikiPageTarget } from "./wiki-shared";

import {
	renderIndex as renderIndexFn,
	parseIndex as parseIndexFn,
	type WikiIndexCtx,
	type WikiIndexSortMode,
	type WikiStatusFilter,
} from "./wiki-index";

import {
	navigateTo as navigateToFn,
	renderPage as renderPageFn,
	type WikiPageCtx,
} from "./wiki-page";

export const VIEW_TYPE_WIKI = "second-brain-wiki";

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
	private sortMode: WikiIndexSortMode = "name-asc";
	private statusFilter: WikiStatusFilter = "all";
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
	private compileOverlay: HTMLElement | null = null;

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

		// 编译完成后自动刷新 wiki 视图（缺口文件、新页面等）
		this.registerEvent(
			(this.app.workspace as any).on("second-brain:compile-complete", () => {
				this.hideCompileOverlay();
				if (!this.wikiPages.length) return;
				void this.loadWiki();
			}),
		);
		this.registerEvent(
			(this.app.workspace as any).on("second-brain:compile-start", () => {
				this.showCompileOverlay();
			}),
		);

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

		const row2 = toolbar.createDiv({ cls: "sb-wiki-toolbar-row2" });
		this.sortSelect = row2.createEl("select", { cls: "sb-wiki-sort sb-wiki-toolbar-select", attr: { title: t("wiki.sortLabel", lang) } });
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
		this.statusSelect = row2.createEl("select", { cls: "sb-wiki-sort sb-wiki-toolbar-select", attr: { title: t("wiki.statusLabel", lang) } });
		const statusOptions: Array<{ value: string; key: string }> = [
			{ value: "all", key: "wiki.filterAll" },
			{ value: "pending", key: "wiki.filterPending" },
			{ value: "reviewed", key: "wiki.statusReviewed" },
			{ value: "gap", key: "wiki.statusGapShort" },
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
		const batchQuick = row2.createEl("button", {
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

	private showCompileOverlay() {
		if (this.compileOverlay) return;
		const container = this.containerEl.children[1] as HTMLElement;
		const overlay = container.createDiv({ cls: "sb-wiki-compile-overlay" });
		overlay.createEl("div", { cls: "sb-wiki-compile-overlay-text", text: t("sb.compiling", this.plugin.settings.language) });
		this.compileOverlay = overlay;
	}

	private hideCompileOverlay() {
		if (!this.compileOverlay) return;
		this.compileOverlay.remove();
		this.compileOverlay = null;
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

	// ---- Index context for wiki-index module ----

	private indexCtx(): WikiIndexCtx {
		return {
			app: this.app,
			plugin: this.plugin,
			bodyEl: this.bodyEl,
			wikiPages: this.wikiPages,
			indexData: this.indexData,
			sortMode: this.sortMode,
			statusFilter: this.statusFilter,
			searchEl: this.searchEl,
			sortSelect: this.sortSelect,
			statusSelect: this.statusSelect,
			indexRenderGeneration: this.indexRenderGeneration,
			pageLimit: this.pageLimit,
			setPageLimit: (v: number) => { this.pageLimit = v; },
			selectedPages: this.selectedPages,
			batchBar: this.batchBar,
			vectorSearchAbort: null,
			findPage: (name) => this.findPage(name),
			navigateTo: (name) => this.navigateTo(name),
			applyWikiStatusFilter: (f, opts) => this.applyWikiStatusFilter(f, opts),
			loadWiki: () => this.loadWiki(),
			renderIndex: () => this.renderIndex(),
			renderPage: (name) => this.renderPage(name),
			markForRegeneration: (target) => this.markForRegeneration(target),
		};
	}

	// ---- Page context for wiki-page module ----

	private pageCtx(): WikiPageCtx & { loadWiki(): Promise<void> } {
		return {
			app: this.app,
			plugin: this.plugin,
			bodyEl: this.bodyEl,
			wikiPages: this.wikiPages,
			currentName: this.currentName,
			navHistory: this.navHistory,
			indexBtn: this.indexBtn,
			mocBtn: this.mocBtn,
			pageScrollTop: this.pageScrollTop,
			component: this.component,
			findPage: (name) => this.findPage(name),
			resolveWikiPage: (target) => this.resolveWikiPage(target),
			renderPage: (name) => this.renderPage(name),
			renderIndex: () => this.renderIndex(),
			showIndex: () => this.showIndex(),
			loadWiki: () => this.loadWiki(),
			navigateTo: (name) => this.navigateTo(name),
			loadPageContent: (page) => this.loadPageContent(page),
		};
	}

	/** 按需加载页面完整内容并更新 wikiPages 中的条目 */
	private async loadPageContent(page: WikiPage): Promise<void> {
		if (page.content.length >= 600) return; // 已有完整内容
		const fullContent = await readWikiPage(this.app, this.plugin.settings.wikiFolder, page.path);
		if (fullContent) page.content = fullContent;
	}

	// ---- Lifecycle ----

	async loadWiki() {
		const wf = this.plugin.settings.wikiFolder;
		this.wikiPages = await scanWikiFiles(this.app, wf);

		const idx = this.wikiPages.find(f => f.path === "index.md" || f.path.endsWith("/index.md"));
		this.indexData = parseIndexFn(idx ? idx.content : "");

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

	// ---- Delegation to wiki-index ----

	private renderIndex(): void {
		renderIndexFn(this.indexCtx());
		// Sync mutable state back from indexCtx
		this.indexRenderGeneration = this.indexCtx().indexRenderGeneration;
		this.pageLimit = this.indexCtx().pageLimit;
		this.batchBar = this.indexCtx().batchBar;
		this.selectedPages = this.indexCtx().selectedPages;
		this.statusFilter = this.indexCtx().statusFilter;
	}

	// ---- Delegation to wiki-page ----

	private async navigateTo(name: string) {
		this.currentView = "page";
		await navigateToFn(name, this.pageCtx());
		// Sync mutable state back
		this.currentName = this.pageCtx().currentName;
		this.navHistory = this.pageCtx().navHistory;
	}

	private async renderPage(name: string) {
		await renderPageFn(name, this.pageCtx());
	}

	private async markAsReviewed(target: string): Promise<void> {
		if ((this.plugin as any).compileMutex?.locked) return;
		const { markAsReviewed: markFn } = await import("./wiki-page");
		await markFn(target, this.pageCtx());
	}

	private async markForRegeneration(target: string): Promise<void> {
		if ((this.plugin as any).compileMutex?.locked) return;
		const { markForRegeneration: markFn } = await import("./wiki-page");
		await markFn(target, this.pageCtx());
	}

	// ---- Shared helpers ----

	private findPage(name: string): WikiPage | undefined {
		return resolveWikiPageTarget(name, this.wikiPages);
	}

	private resolveWikiPage(target: string): WikiPage | undefined {
		return resolveWikiPageTarget(target, this.wikiPages);
	}

	async onClose() {
		this.component.unload();
		if (this.searchTimer) {
			clearTimeout(this.searchTimer);
			this.searchTimer = null;
		}
		this.pageScrollTop.clear();
		for (const el of this.wikiHeaderActionEls) el.remove();
		this.wikiHeaderActionEls = [];
	}
}

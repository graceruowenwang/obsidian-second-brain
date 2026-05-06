// Wiki 索引渲染 -- 从 wiki-view.ts 拆分

import { Notice } from "obsidian";
import { runCompile } from "../core/compile";
import { openPluginSettings } from "../types";
import { computeWikiHealth, WIKI_STALE_THRESHOLD_DAYS } from "../core/health";
import type { WikiHealth } from "../core/health";
import { vectorSearch } from "../core/file-utils";
import { t } from "../core/i18n";
import { hasAnySampleSource, loadSamplesIntoVault } from "../core/sample-loader";
import type { WikiPage, IndexItem, IndexSection } from "./wiki-shared";
import {
	extractFmField,
	extractTags,
	extractUpdated,
	extractStatus,
	wikiReviewBucket,
	wikiStatusNorm,
	countIndexUnresolvedLinks,
	parseWikiIndexListItem,
} from "./wiki-shared";

// ---- Types ----

export type WikiIndexSortMode = "name-asc" | "name-desc" | "type" | "level" | "recent";
export type WikiStatusFilter = "all" | "pending" | "reviewed" | "gap" | "other";

export interface WikiIndexEntry {
	name: string;
	display: string;
	desc: string;
	section: string;
	subSection: string;
}

export interface WikiIndexCtx {
	app: import("obsidian").App;
	plugin: import("../types").SecondBrainPlugin;
	bodyEl: HTMLElement;
	wikiPages: WikiPage[];
	indexData: IndexSection[];
	sortMode: WikiIndexSortMode;
	statusFilter: WikiStatusFilter;
	searchEl: HTMLInputElement;
	sortSelect: HTMLSelectElement;
	statusSelect: HTMLSelectElement;
	indexRenderGeneration: number;
	pageLimit: number;
	setPageLimit: (v: number) => void;
	selectedPages: Set<string>;
	batchBar: HTMLElement | null;
	vectorSearchAbort: AbortController | null;
	findPage(name: string): WikiPage | undefined;
	navigateTo(name: string): Promise<void>;
	applyWikiStatusFilter(f: WikiStatusFilter, opts?: { resetQuery?: boolean; forceIndex?: boolean }): void;
	loadWiki(): Promise<void>;
	renderIndex(): void;
	renderPage(name: string): Promise<void>;
	markForRegeneration(target: string): Promise<void>;
}

// ---- Text Highlight Helper ----

function highlightText(text: string, query: string): DocumentFragment {
	const frag = document.createDocumentFragment();
	if (!query) {
		frag.textContent = text;
		return frag;
	}
	const lower = text.toLowerCase();
	const qLower = query.toLowerCase();
	let lastIdx = 0;
	let idx = lower.indexOf(qLower, lastIdx);
	while (idx !== -1) {
		if (idx > lastIdx) frag.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
		const mark = document.createElement("mark");
		mark.className = "sb-highlight";
		mark.textContent = text.slice(idx, idx + query.length);
		frag.appendChild(mark);
		lastIdx = idx + query.length;
		idx = lower.indexOf(qLower, lastIdx);
	}
	if (lastIdx < text.length) frag.appendChild(document.createTextNode(text.slice(lastIdx)));
	return frag;
}

export function parseIndex(content: string): IndexSection[] {
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

export function sortPageEntries(
	entries: WikiIndexEntry[],
	findPage: (name: string) => WikiPage | undefined,
	sortMode: WikiIndexSortMode,
): WikiIndexEntry[] {
	const copy = [...entries];
	const page = (name: string) => findPage(name);
	const getUpdated = (name: string) => extractUpdated(page(name)?.content || "") || "";
	const getType = (name: string) => (page(name) ? extractFmField(page(name)!.content, "type") : "") || "";
	const getLevel = (name: string) => (page(name) ? extractFmField(page(name)!.content, "level") : "") || "";
	const cmpName = (a: WikiIndexEntry, b: WikiIndexEntry) =>
		a.display.localeCompare(b.display, undefined, { sensitivity: "base" });

	switch (sortMode) {
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

export function appendWikiListRow(
	container: HTMLElement,
	entry: WikiIndexEntry,
	lang: string,
	opts: {
		findPage: (name: string) => WikiPage | undefined;
		navigateTo: (name: string) => void;
		semantic?: boolean;
			highlightQuery?: string;
	},
): void {
	const page = opts.findPage(entry.name);
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
		cls: "sb-wiki-list-row" + (opts.semantic ? " sb-wiki-list-row-semantic" : ""),
		attr: { "data-name": entry.name },
	});
	if (path) row.setAttribute("data-path", path);
	row.setAttribute("role", "button");
	row.tabIndex = 0;
	row.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			opts.navigateTo(entry.name);
		}
	});
	row.addEventListener("click", (ev) => {
		if ((ev.target as HTMLElement).closest(".sb-batch-checkbox")) return;
		opts.navigateTo(entry.name);
	});

	const kindEl = row.createDiv({ cls: `sb-wiki-list-kind sb-wiki-list-kind-${kind}`, text: t(kindKey, lang) });
	kindEl.setAttribute("aria-hidden", "true");

	const main = row.createDiv({ cls: "sb-wiki-list-main" });
	const titleEl = main.createEl("div", { cls: "sb-wiki-list-title" });
	titleEl.appendChild(highlightText(entry.display, opts.highlightQuery || ""));
	const trail = [entry.section, entry.subSection].filter(Boolean).join(" > ");
	if (trail) main.createDiv({ cls: "sb-wiki-list-path", text: trail });
	if (entry.desc) {
		const descEl = main.createEl("div", { cls: "sb-wiki-list-desc" });
		descEl.appendChild(highlightText(entry.desc.slice(0, 160), opts.highlightQuery || ""));
	}
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

export function renderWikiEmpty(
	bodyEl: HTMLElement,
	lang: string,
	app: import("obsidian").App,
	plugin: import("../types").SecondBrainPlugin,
): void {
	bodyEl.createDiv({ cls: "sb-wiki-empty" });
	const guidance = bodyEl.createDiv({ cls: "sb-wiki-empty-guidance" });
	guidance.createEl("h3", { text: t("empty.wikiTitle", lang) });
	const steps = guidance.createDiv({ cls: "sb-empty-steps" });
	const step1 = steps.createDiv({ cls: "sb-empty-step" });
	step1.createEl("span", { text: "1", cls: "sb-empty-step-num" });
	step1.createEl("span", { text: t("empty.step1Put", lang), cls: "sb-empty-step-text" });
	const hasSampleSource = hasAnySampleSource(app);
	const rawFolder = plugin.settings.rawFolder;
	const wikiFolder = plugin.settings.wikiFolder;
	const rawDir = app.vault.getAbstractFileByPath(rawFolder);
	let rawHasFiles = false;
	if (rawDir) {
		const allFiles = app.vault.getFiles();
		rawHasFiles = allFiles.some(f => f.path.startsWith(rawFolder + "/") && !f.path.includes("_usage"));
	}
	if (!rawHasFiles && hasSampleSource) {
		const sampleBtn = guidance.createEl("button", { text: t("empty.loadSamples", lang), cls: "sb-empty-btn" });
		sampleBtn.classList.add("sb-mb-8");
		sampleBtn.addEventListener("click", () => {
			void (async () => {
			sampleBtn.textContent = "...";
			try {
				await loadSamplesIntoVault(app, rawFolder, wikiFolder);
				sampleBtn.textContent = t("empty.samplesLoaded", lang);
			} catch (e) {
				sampleBtn.textContent = t("empty.samplesFail", lang);
			}
			})();
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
		.addEventListener("click", () => openPluginSettings(app));
	btnRow.createEl("button", { text: t("empty.startCompile", lang), cls: "sb-empty-btn mod-cta" })
		.addEventListener("click", () => plugin.activateView("second-brain-compile"));
}

export function buildIssueRow(
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

export function buildWikiDataPanel(
	bodyEl: HTMLElement,
	lang: string,
	cc: number,
	ec: number,
	sc: number,
	health: WikiHealth,
	indexMissingLinks: number,
	actions: {
		applyWikiStatusFilter: (f: WikiStatusFilter) => void;
		runActionCompile: (btn: HTMLButtonElement) => Promise<void>;
		navigateTo: (name: string) => Promise<void>;
		markForRegeneration: (target: string) => Promise<void>;
	},
): void {
	const days = String(WIKI_STALE_THRESHOLD_DAYS);
	const totalPages = health.total;
	const pendingCount = health.pending;
	const otherCount = health.other;
	const reviewedCount = health.reviewed;
	const reviewPct = totalPages > 0 ? Math.round((reviewedCount / totalPages) * 100) : 0;

	// --- 概览行 ---
	const overview = bodyEl.createDiv({ cls: "sb-qa-overview" });
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
		bodyEl.createEl("p", { cls: "sb-wiki-data-section-text", text: t("wiki.dataPanelNoPages", lang) });
		return;
	}

	// --- 待处理事项 ---
	const hasIssues = pendingCount > 0 || health.gapPages > 0 || health.staleness > 30 || health.orphanRisk > 20 || indexMissingLinks > 0 || otherCount > 0;

	if (hasIssues) {
		bodyEl.createEl("div", { cls: "sb-qa-section-label", text: t("wiki.actionCardTitle", lang) });
	}

	const list = bodyEl.createDiv({ cls: "sb-qa-list" });

	// 1) 待审核
	if (pendingCount > 0) {
		const row = buildIssueRow(list, {
			severity: "warn",
			title: t("wiki.issuePending", lang, { n: String(pendingCount) }),
			actionLabel: t("wiki.issuePendingAction", lang),
			onAction: () => actions.applyWikiStatusFilter("pending"),
		});
		row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issuePendingDesc", lang) });
	}

	// 2) 知识缺口
	if (health.gapPages > 0) {
		const row = buildIssueRow(list, {
			severity: "err",
			title: t("wiki.issueGap", lang, { n: String(health.gapPages) }),
			actionLabel: t("wiki.issueGapAction", lang),
			onAction: () => actions.applyWikiStatusFilter("gap"),
		});
		row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueGapDesc", lang) });
	}

	// 3) 概念过时
	if (health.staleness > 30) {
		const row = buildIssueRow(list, {
			severity: "warn",
			title: t("wiki.issueStale", lang, { pct: String(health.staleness), days }),
			actionLabel: t("wiki.issueStaleAction", lang),
			onAction: (btn) => void actions.runActionCompile(btn),
		});
		if (health.stalePages.length > 0) {
			const sub = row.createDiv({ cls: "sb-qa-stale-sub" });
			for (const sp of health.stalePages) {
				const sr = sub.createDiv({ cls: "sb-qa-stale-row" });
				sr.createEl("a", { text: sp.name, cls: "sb-qa-stale-name" }).addEventListener("click", (ev) => {
					ev.preventDefault();
					void actions.navigateTo(sp.name);
				});
				sr.createEl("span", { cls: "sb-qa-stale-days", text: t("health.daysAgo", lang, { n: String(sp.daysSinceUpdate) }) });
				sr.createEl("button", { cls: "sb-qa-stale-regen", text: t("wiki.issueStaleRegen", lang) })
					.addEventListener("click", (ev) => {
						void (async () => {
						ev.preventDefault();
						ev.stopPropagation();
						(ev.target as HTMLElement).textContent = "...";
						await actions.markForRegeneration(sp.path);
						})();
					});
			}
		}
	}

	// 4) 孤岛风险
	if (health.orphanRisk > 20) {
		const row = buildIssueRow(list, {
			severity: "info",
			title: t("wiki.issueOrphan", lang, { pct: String(health.orphanRisk) }),
			actionLabel: t("wiki.issueOrphanAction", lang),
			onAction: (btn) => void actions.runActionCompile(btn),
		});
		row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueOrphanDesc", lang) });
	}

	// 5) 索引链接失效
	if (indexMissingLinks > 0) {
		const row = buildIssueRow(list, {
			severity: "info",
			title: t("wiki.issueIndexMissing", lang, { n: String(indexMissingLinks) }),
		});
		row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueIndexMissingDesc", lang) });
	}

	// 6) 其他状态
	if (otherCount > 0 && pendingCount === 0) {
		const row = buildIssueRow(list, {
			severity: "info",
			title: t("wiki.issueOther", lang, { n: String(otherCount) }),
			actionLabel: t("wiki.issueOtherAction", lang),
			onAction: () => actions.applyWikiStatusFilter("other"),
		});
		row.createEl("div", { cls: "sb-qa-row-sub", text: t("wiki.issueOtherDesc", lang) });
	}

	// 一切正常
	if (!hasIssues) {
		bodyEl.createDiv({ cls: "sb-qa-all-clear", text: t("wiki.issueAllClear", lang) });
	}
}

export async function runActionCompile(
	btn: HTMLButtonElement,
	lang: string,
	app: import("obsidian").App,
	plugin: import("../types").SecondBrainPlugin,
	loadWiki: () => Promise<void>,
	wikiPages: WikiPage[],
): Promise<void> {
	if (!plugin.settings.apiKey) {
		new Notice(t("notice.noApiKey", lang));
		return;
	}
	const orig = btn.textContent || "";
	btn.textContent = t("wiki.actionRunning", lang);
	btn.setAttribute("disabled", "true");
	try {
		await plugin.runWithCompileLock(() =>
			runCompile(app, plugin.settings, () => {}, false, plugin),
		);
		await loadWiki();
		new Notice(t("notice.compileDone", lang, { n: String(wikiPages.length) }));
	} catch (e) {
		new Notice(t("wiki.healthRepairFailed", lang, { msg: (e as Error).message }));
	} finally {
		btn.textContent = orig;
		btn.removeAttribute("disabled");
	}
}

// ---- Main Index Render ----

export function renderIndex(ctx: WikiIndexCtx): void {
	const query = (ctx.searchEl?.value || "").toLowerCase();
	const lang = ctx.plugin.settings.language;
	const indexGen = ++ctx.indexRenderGeneration;
	if (ctx.sortSelect) ctx.sortSelect.value = ctx.sortMode;
	if (ctx.statusSelect) ctx.statusSelect.value = ctx.statusFilter;
	ctx.bodyEl.empty();
	ctx.batchBar = null;
	ctx.selectedPages.clear();

	if (ctx.wikiPages.length === 0) {
		renderWikiEmpty(ctx.bodyEl, lang, ctx.app, ctx.plugin);
		return;
	}

	if (!query) {
		const cc = ctx.wikiPages.filter(f => f.path.includes("concepts/")).length;
		const ec = ctx.wikiPages.filter(f => f.path.includes("entities/")).length;
		const sc = ctx.wikiPages.filter(f => f.path.includes("sources/")).length;
		const health = computeWikiHealth(ctx.wikiPages);
		const indexMissingLinks = countIndexUnresolvedLinks(ctx.indexData, ctx.wikiPages);
		buildWikiDataPanel(ctx.bodyEl, lang, cc, ec, sc, health, indexMissingLinks, {
			applyWikiStatusFilter: (f) => ctx.applyWikiStatusFilter(f),
			runActionCompile: (btn) => runActionCompile(btn, lang, ctx.app, ctx.plugin, () => ctx.loadWiki(), ctx.wikiPages),
			navigateTo: (name) => ctx.navigateTo(name),
			markForRegeneration: (target) => ctx.markForRegeneration(target),
		});

	} else {
		const matchCount = ctx.wikiPages.filter(f => {
			const name = f.path.split("/").pop()!.replace(".md", "");
			if (name === "index" || name === "log") return false;
			return name.toLowerCase().includes(query) || f.content.toLowerCase().includes(query);
		}).length;
		ctx.bodyEl.createEl("p", { text: t("wiki.searchResultsCount", lang, { n: String(matchCount) }), cls: "sb-wiki-search-hint" });
	}

		// 统一页面列表：合并 index 条目和非 index 页面
		const indexedPaths = new Set<string>();

		const entries: WikiIndexEntry[] = [];

		// index 条目
		for (const sec of ctx.indexData) {
			for (const sub of sec.subs) {
				for (const item of sub.items) {
					entries.push({ name: item.name, display: item.display, desc: item.desc || "", section: sec.title, subSection: sub.title });
					const hit = ctx.findPage(item.name);
					if (hit) indexedPaths.add(hit.path);
				}
			}
		}

		// 不在 index 中的页面
		for (const f of ctx.wikiPages) {
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
				const page = ctx.findPage(e.name);
				return page != null && page.content.toLowerCase().includes(query);
			}).map(e => e.name));

			// 后台语义搜索，有结果时追加渲染
			const filesMap: Record<string, string> = {};
			for (const p of ctx.wikiPages) filesMap[p.path] = p.content;
			if (ctx.vectorSearchAbort) ctx.vectorSearchAbort.abort();
				const searchAbort = new AbortController();
				ctx.vectorSearchAbort = searchAbort;
				vectorSearch(query, filesMap, ctx.plugin.settings, 10, searchAbort.signal).then(results => {
				if (indexGen !== ctx.indexRenderGeneration) return;
				const currentView = (ctx as unknown as { currentView?: string }).currentView;
				if (currentView !== undefined && currentView !== "index") return;
				const semanticNames = new Set<string>();
				for (const r of results) {
					const rName = r.filePath.split("/").pop()!.replace(".md", "");
					if (!keywordMatch.has(rName)) semanticNames.add(rName);
					semanticNames.add(r.filePath.replace(/\\/g, "/"));
				}
				if (semanticNames.size === 0) return;
				const semEntries = entries.filter(e => semanticNames.has(e.name));
				if (semEntries.length === 0) return;
				const host = ctx.bodyEl.querySelector(".sb-wiki-index-scroll");
				if (!host) return;
				host.createEl("h2", { text: t("wiki.semanticMatch", lang), cls: "sb-wiki-h2 sb-wiki-list-section-title" });
				const semList = host.createDiv({ cls: "sb-wiki-list sb-wiki-list-semantic" });
				for (const entry of sortPageEntries(semEntries, ctx.findPage, ctx.sortMode)) {
					appendWikiListRow(semList, entry, lang, {
						findPage: ctx.findPage,
						navigateTo: (n) => ctx.navigateTo(n),
						semantic: true,
						highlightQuery: query,
					});
				}
			}).catch(() => {});

			filtered = entries.filter(e => keywordMatch.has(e.name));
		}

		if (ctx.statusFilter !== "all") {
			filtered = filtered.filter((e: WikiIndexEntry) => {
				const page = ctx.findPage(e.name);
				if (!page) return false;
				if (ctx.statusFilter === "gap") return wikiStatusNorm(page.content) === "gap";
			return wikiReviewBucket(page.content) === ctx.statusFilter;
			});
		}

		const sorted = sortPageEntries(filtered, ctx.findPage, ctx.sortMode);
			// 筛选结果为空且非 all 筛选 -> 自动重置
			if (sorted.length === 0 && ctx.statusFilter !== "all" && entries.length > 0) {
				ctx.statusFilter = "all";
				if (ctx.statusSelect) ctx.statusSelect.value = "all";
				ctx.renderIndex();
				return;
			}
		const listMount = ctx.bodyEl.createDiv({ cls: "sb-wiki-index-scroll" });
		listMount.createEl("h2", { text: t("wiki.pagesHeading", lang), cls: "sb-wiki-h2 sb-wiki-list-section-title" });
		const listRoot = listMount.createDiv({ cls: "sb-wiki-list" });
		const visible = sorted.slice(0, ctx.pageLimit);
		for (const entry of visible) {
			appendWikiListRow(listRoot, entry, lang, {
				findPage: ctx.findPage,
				navigateTo: (n) => ctx.navigateTo(n),
			});
		}
		if (sorted.length === 0) {
			listRoot.createDiv({ cls: "sb-wiki-list-empty", text: t("wiki.listEmpty", lang) });
		}

		if (sorted.length > ctx.pageLimit) {
			const loadMoreBtn = listMount.createEl("button", {
				text: t("wiki.loadMore", lang, { n: String(sorted.length - ctx.pageLimit) }),
				cls: "sb-wiki-load-more",
			});
			loadMoreBtn.addEventListener("click", () => {
				ctx.setPageLimit(ctx.pageLimit + 50);
				ctx.renderIndex();
			});
		}
}

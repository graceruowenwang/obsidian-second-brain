// Wiki 页面渲染与导航 -- 从 wiki-view.ts 拆分

import { MarkdownRenderer, Component, Notice, TFile, setIcon } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { writeLogEntry } from "../core/file-utils";
import { t } from "../core/i18n";
import { setAsyncButton } from "../ui/async-button";
import type { WikiPage } from "./wiki-shared";
import { confirmDialog } from "./wiki-shared";
import {
	extractFmField,
	stripFrontmatter,
	extractStatus,
	extractUpdated,
	extractFmArray,
	extractExecutiveSummary,
	wikiStatusNorm,
	setWikiFrontmatterStatus,
} from "./wiki-shared";

// ---- Types ----

export interface WikiPageCtx {
	app: import("obsidian").App;
	plugin: SecondBrainPlugin;
	bodyEl: HTMLElement;
	wikiPages: WikiPage[];
	currentName: string;
	navHistory: string[];
	indexBtn: HTMLButtonElement;
	mocBtn: HTMLButtonElement;
	pageScrollTop: Map<string, number>;
	component: Component;
	findPage(name: string): WikiPage | undefined;
	resolveWikiPage(target: string): WikiPage | undefined;
	renderPage(name: string): Promise<void>;
	renderIndex(): void;
	showIndex(): void;
	loadWiki(): Promise<void>;
	navigateTo(name: string): Promise<void>;
	/** 按需加载页面完整内容（替换 frontmatter 摘要） */
	loadPageContent(page: WikiPage): Promise<void>;
}

// ---- Helper ----

/** Stable heading ids for in-preview outline links */
export function wikiHeadingSlug(text: string, used: Set<string>): string {
	let slug = (text || "section")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9一-鿿-]+/gi, "")
		.replace(/^-+|-+$/g, "") || "section";
	if (slug.length > 64) slug = slug.slice(0, 64);
	let id = slug;
	let n = 0;
	while (used.has(id)) id = `${slug}-${++n}`;
	used.add(id);
	return id;
}

// ---- Navigation ----

export async function navigateTo(
	name: string,
	ctx: WikiPageCtx,
): Promise<void> {
	if (ctx.bodyEl && ctx.currentName) {
		ctx.pageScrollTop.set(ctx.currentName, ctx.bodyEl.scrollTop);
	}
	const marker = ctx.currentName;
	ctx.navHistory.push(marker);
	ctx.currentName = name;
	ctx.indexBtn.classList.remove("active");
	ctx.mocBtn.classList.remove("active");
	await ctx.renderPage(name);
}

export async function goBack(
	ctx: WikiPageCtx,
	showIndex: () => void,
): Promise<void> {
	if (ctx.bodyEl && ctx.currentName) {
		ctx.pageScrollTop.set(ctx.currentName, ctx.bodyEl.scrollTop);
	}
	const prev = ctx.navHistory.pop();
	if (!prev || prev === "") {
		showIndex();
		return;
	}
	ctx.currentName = prev;
	await ctx.renderPage(prev);
}

// ---- Page Rendering ----

export async function renderPage(
	name: string,
	ctx: WikiPageCtx,
): Promise<void> {
	const lang = ctx.plugin.settings.language;
	ctx.bodyEl.empty();
	const page = ctx.findPage(name);
	if (!page) {
		ctx.bodyEl.createDiv({ cls: "sb-wiki-empty", text: t("wiki.pageNotFound", lang, { name }) });
		return;
	}

	// 按需加载完整内容（初始扫描只含 frontmatter 摘要）
	await ctx.loadPageContent(page);

	const breadcrumb = ctx.bodyEl.createDiv({ cls: "sb-wiki-breadcrumb" });
	const backBtn = breadcrumb.createEl("button", { cls: "sb-wiki-back", attr: { "aria-label": t("wiki.backNav", lang) } });
	backBtn.addEventListener("click", () => { void goBack(ctx, ctx.showIndex); });
	const backIcon = backBtn.createSpan({ cls: "sb-wiki-back-icon-wrap" });
	setIcon(backIcon, "arrow-left");
	backBtn.createSpan({ text: t("wiki.backNav", lang), cls: "sb-wiki-back-text" });
	breadcrumb.createEl("span", { text: name, cls: "sb-wiki-breadcrumb-title" });

	breadcrumb.createEl("button", { text: t("wiki.openEditor", lang), cls: "sb-wiki-edit-btn" })
		.addEventListener("click", () => openInEditor(name, ctx));

	// 审核横幅放在最上：长文/摘要/素材区会把按钮顶出首屏，易被误认为「没有审核」
	renderWikiReviewBanner(ctx.bodyEl, lang, name, page, ctx);

	const expressBtn = breadcrumb.createEl("button", { text: t("wiki.generateArticle", lang), cls: "sb-wiki-generate-btn" });
	expressBtn.addEventListener("click", () => {
		void (async () => {
		const confirmed = await confirmDialog(ctx.app, {
			title: t("wiki.generateArticle", lang),
			message: t("wiki.generateArticleConfirm", lang),
			confirmText: t("wiki.generateArticle", lang),
			cancelText: t("set.cancel", lang),
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
			], ctx.plugin.settings, { maxTokens: 3000, temperature: 0.5 });
			const article = `---\ntitle: "${name}"\ntype: article\nsource_wiki: "${page.path}"\nlast_updated: ${today}\n---\n\n${result.trim()}\n`;
			await ensureFolder(ctx.app, "blog");
			const blogPath = `blog/${name}-${today}.md`;
			const existing = ctx.app.vault.getAbstractFileByPath(blogPath);
			if (existing instanceof TFile) await ctx.app.vault.modify(existing, article);
			else await ctx.app.vault.create(blogPath, article);
			setAsyncButton(expressBtn, false, t("wiki.articleGenerated", lang));
			new Notice(t("wiki.articleGeneratedNotice", lang));
		} catch (_e) {
			setAsyncButton(expressBtn, false, t("wiki.generateArticle", lang));
			new Notice(t("wiki.generateFailed", lang));
		}
		})();
	});

	const metaRow = ctx.bodyEl.createDiv({ cls: "sb-wiki-meta" });
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
		const sumEl = ctx.bodyEl.createDiv({ cls: "sb-wiki-executive-summary" });
		sumEl.createEl("div", { text: t("wiki.executiveSummaryTitle", lang), cls: "sb-wiki-executive-summary-title" });
		sumEl.createEl("div", { text: execSummary, cls: "sb-wiki-executive-summary-body" });
	}

	// Feature 3: Source citation display
	const originalSources = extractFmArray(page.content, "original");
	const referenceSources = extractFmArray(page.content, "reference");
	if (originalSources.length > 0 || referenceSources.length > 0) {
		const sourcesEl = ctx.bodyEl.createDiv({ cls: "sb-wiki-sources" });
		sourcesEl.createEl("h4", { text: t("wiki.sourcesLabel", lang), cls: "sb-wiki-sources-title" });
		if (originalSources.length > 0) {
			const origSection = sourcesEl.createDiv({ cls: "sb-wiki-source-group" });
			origSection.createEl("span", { text: t("wiki.originalSources", lang), cls: "sb-wiki-source-type-label" });
			for (const src of originalSources) {
				const chip = origSection.createEl("a", { text: src.split("/").pop() || src, cls: "sb-wiki-source-chip sb-wiki-source-original" });
				chip.addEventListener("click", (ev) => {
					ev.preventDefault();
					const file = ctx.app.vault.getAbstractFileByPath(src);
					if (file instanceof TFile) {
						ctx.app.workspace.getLeaf(false).openFile(file);
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
					const file = ctx.app.vault.getAbstractFileByPath(src);
					if (file instanceof TFile) {
						ctx.app.workspace.getLeaf(false).openFile(file);
					}
				});
			}
		}
	}

	const pageWrap = ctx.bodyEl.createDiv({ cls: "sb-wiki-page-wrap" });
	const tocCol = pageWrap.createDiv({ cls: "sb-wiki-toc-col" });
	const contentEl = pageWrap.createDiv({ cls: "sb-wiki-page-content" });
	const stripped = stripFrontmatter(page.content);
	const wf = ctx.plugin.settings.wikiFolder;
	const sourcePath = `${wf}/${page.path}`;
	ctx.component.unload();
	ctx.component = new Component();
	await MarkdownRenderer.render(ctx.app, stripped, contentEl, sourcePath, ctx.component);

	attachPageOutline(lang, tocCol, contentEl);
	wireInternalLinks(contentEl, wf, ctx);

	const savedScroll = ctx.pageScrollTop.get(name);
	if (savedScroll != null) {
		requestAnimationFrame(() => {
			ctx.bodyEl.scrollTop = savedScroll;
			ctx.pageScrollTop.delete(name);
		});
	}

	const backlinks = findBacklinks(name, ctx.wikiPages);
	if (backlinks.length > 0) {
		ctx.bodyEl.createEl("h3", { text: t("wiki.backlinks", lang), cls: "sb-wiki-backlinks-title" });
		const blGrid = ctx.bodyEl.createDiv({ cls: "sb-wiki-backlinks-grid" });
		for (const bl of backlinks) {
			blGrid.createEl("a", { text: bl.display, cls: "sb-wiki-backlink-chip" })
				.addEventListener("click", (ev) => { ev.preventDefault(); void ctx.navigateTo(bl.name); });
		}
	}
}

// ---- Standalone Page Functions ----

export function attachPageOutline(lang: string, tocCol: HTMLElement, contentEl: HTMLElement): void {
	tocCol.empty();
	tocCol.classList.add("sb-hidden");

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

	tocCol.classList.remove("sb-hidden");
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

export function wireInternalLinks(contentEl: HTMLElement, wikiFolder: string, ctx: WikiPageCtx): void {
	contentEl.querySelectorAll("a.internal-link").forEach((el) => {
			const link = el as HTMLAnchorElement;
		const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
		const targetName = href.split("/").pop()!.replace(".md", "").split("|")[0].split("#")[0];
		const target = ctx.findPage(targetName);
		if (!target) link.classList.add("is-unresolved");

		link.addEventListener("click", (ev) => {
			if (ev.metaKey || ev.ctrlKey) {
				ev.preventDefault();
				ev.stopPropagation();
				if (target) {
					const fullPath = `${wikiFolder}/${target.path}`;
					const file = ctx.app.vault.getAbstractFileByPath(fullPath);
					if (file instanceof TFile) {
						ctx.app.workspace.getLeaf("tab").openFile(file);
					}
				}
				return;
			}
			ev.preventDefault();
			ev.stopPropagation();
			ctx.navigateTo(targetName);
		});
	});
}

export function renderWikiReviewBanner(
	bodyEl: HTMLElement,
	lang: string,
	name: string,
	page: WikiPage,
	ctx: WikiPageCtx,
): void {
	const sn = wikiStatusNorm(page.content);
	const rawStatus = extractStatus(page.content).trim();

	if (sn === "gap") {
		const banner = bodyEl.createDiv({ cls: "sb-draft-banner" });
		banner.createEl("span", { text: t("wiki.gap", lang), cls: "sb-draft-label" });
		const regenBtn = banner.createEl("button", { text: t("wiki.regeneratePage", lang), cls: "sb-draft-review-btn" });
		regenBtn.addEventListener("click", () => {
			void (async () => {
			regenBtn.textContent = "...";
			// 删除 stub 文件后重新编译
			const wf = ctx.plugin.settings.wikiFolder;
			const fullPath = `${wf}/${page.path}`;
			const file = ctx.app.vault.getAbstractFileByPath(fullPath);
			if (file instanceof TFile) {
				await ctx.app.vault.trash(file, true);
			}
			try {
				const { runCompile } = await import("../core/compile");
				await ctx.plugin.runWithCompileLock(() =>
					runCompile(ctx.app, ctx.plugin.settings, undefined, false, ctx.plugin as unknown as import("../core/file-utils").StorageLike),
				);
				await ctx.loadWiki();
				ctx.showIndex();
			} catch (e) {
				console.warn("gap regen: compile failed:", e);
			}
			})();
		});
	} else if (sn === "outdated") {
		const banner = bodyEl.createDiv({ cls: "sb-draft-banner" });
		banner.createEl("span", { text: t("wiki.outdated", lang), cls: "sb-draft-label" });
		const regenBtn = banner.createEl("button", { text: t("wiki.regeneratePage", lang), cls: "sb-draft-review-btn" });
		regenBtn.addEventListener("click", () => {
			void (async () => {
			await markForRegeneration(page.path, ctx);
			regenBtn.textContent = t("wiki.regeneratePageDone", lang);
			regenBtn.setAttribute("disabled", "true");
			})();
		});
	} else if (sn === "draft" || sn === "" || sn === "pending") {
		const banner = bodyEl.createDiv({ cls: "sb-draft-banner" });
		const label = rawStatus === "" ? t("wiki.statusPendingUnmarked", lang)
			: sn === "pending" ? t("wiki.statusPendingKeyword", lang)
				: t("wiki.draft", lang);
		banner.createEl("span", { text: label, cls: "sb-draft-label" });
		const reviewBtn = banner.createEl("button", { text: t("wiki.markReviewed", lang), cls: "sb-draft-review-btn" });
		reviewBtn.addEventListener("click", () => {
			void (async () => {
			await markAsReviewed(page.path, ctx);
			await ctx.renderPage(name);
			})();
		});
	} else if (sn === "reviewed") {
		const banner = bodyEl.createDiv({ cls: "sb-reviewed-banner" });
		banner.createEl("span", { text: t("wiki.reviewed", lang), cls: "sb-draft-label" });
		const summaryBtn = banner.createEl("button", { text: t("wiki.distillSummary", lang), cls: "sb-draft-review-btn" });
		summaryBtn.addEventListener("click", () => {
			void (async () => {
			summaryBtn.textContent = "...";
			try {
				const { callLLM } = await import("../core/llm");
				const strippedContent = stripFrontmatter(page.content);
				const result = await callLLM([
					{ role: "system", content: "Knowledge distiller. 2-3 sentence executive summary in the page's language." },
					{ role: "user", content: `Summarize key insight in 2-3 sentences:\n\n${strippedContent.slice(0, 4000)}` },
				], ctx.plugin.settings, { maxTokens: 200, temperature: 0.2 });
				const summary = result.trim();
				let updated = page.content;
				if (/^executive_summary:/m.test(updated)) {
					updated = updated.replace(/^executive_summary:.*$/m, `executive_summary: "${summary.replace(/"/g, '\\"')}"`);
				} else {
					updated = updated.replace(/^(---\n)/, `$1executive_summary: "${summary.replace(/"/g, '\\"')}"\n`);
				}
				const wf = ctx.plugin.settings.wikiFolder;
				const fullPath = `${wf}/${page.path}`;
				const file = ctx.app.vault.getAbstractFileByPath(fullPath);
				if (file instanceof TFile) {
					await ctx.app.vault.modify(file, updated);
					page.content = updated;
				}
				summaryBtn.textContent = t("wiki.summaryDistilled", lang);
				summaryBtn.classList.add("mod-cta");
				new Notice(t("wiki.summaryDistilledHint", lang));
				await ctx.renderPage(name);
			} catch (e) {
				summaryBtn.textContent = t("wiki.distillSummary", lang);
				new Notice(t("wiki.summaryDistillFail", lang, { msg: e instanceof Error ? e.message : String(e) }));
			}
			})();
		});
	}
}

export function openInEditor(name: string, ctx: WikiPageCtx): void {
	const page = ctx.findPage(name);
	if (page) {
		const wf = ctx.plugin.settings.wikiFolder;
		const fullPath = `${wf}/${page.path}`;
		const file = ctx.app.vault.getAbstractFileByPath(fullPath);
		if (file instanceof TFile) {
			ctx.app.workspace.getLeaf(false).openFile(file);
			return;
		}
	}
	new Notice(t("wiki.pageNotFound", ctx.plugin.settings.language, { name }));
}

export async function markAsReviewed(target: string, ctx: WikiPageCtx): Promise<void> {
	const page = ctx.resolveWikiPage(target);
	if (!page) return;
	const prevStatus = extractStatus(page.content) || "(none)";
	const shortName = page.path.split("/").pop()!.replace(/\.md$/i, "");
	const updated = setWikiFrontmatterStatus(page.content, "reviewed");
	const wf = ctx.plugin.settings.wikiFolder;
	const fullPath = `${wf}/${page.path}`;
	const file = ctx.app.vault.getAbstractFileByPath(fullPath);
	if (file instanceof TFile) {
		await ctx.app.vault.modify(file, updated);
		page.content = updated;
		const pageType = extractFmField(page.content, "type") || "unknown";
			const pageLevel = extractFmField(page.content, "level") || "";
			await writeLogEntry(ctx.app, wf, "sync", `Reviewed: [[${shortName}]]`,
				`- type: ${pageType}, level: ${pageLevel}\n- status: ${prevStatus} → reviewed`);
	}
}

export async function markForRegeneration(target: string, ctx: WikiPageCtx & { loadWiki(): Promise<void> }): Promise<void> {
	const page = ctx.resolveWikiPage(target);
	if (!page) return;
	const prevStatus = extractStatus(page.content) || "(none)";
	const shortName = page.path.split("/").pop()!.replace(/\.md$/i, "");
	const updated = setWikiFrontmatterStatus(page.content, "draft");
	const wf = ctx.plugin.settings.wikiFolder;
	const fullPath = `${wf}/${page.path}`;
	const file = ctx.app.vault.getAbstractFileByPath(fullPath);
	if (file instanceof TFile) {
		await ctx.app.vault.modify(file, updated);
		page.content = updated;
		new Notice(t("wiki.regeneratePageDone", ctx.plugin.settings.language));
			await writeLogEntry(ctx.app, wf, "sync", `Regenerate: [[${shortName}]]`,
				`- status: ${prevStatus} → draft`);
		try {
			const { runCompile } = await import("../core/compile");
			await ctx.plugin.runWithCompileLock(() =>
				runCompile(ctx.app, ctx.plugin.settings, undefined, false, ctx.plugin as unknown as import("../core/file-utils").StorageLike),
			);
			await ctx.loadWiki();
			await ctx.renderPage(shortName);
		} catch (e) {
			console.warn("markForRegeneration: compile failed:", e);
		}
	}
}

export function findBacklinks(name: string, wikiPages: WikiPage[]): Array<{ name: string; display: string }> {
	const results: Array<{ name: string; display: string }> = [];
	const searchPatterns = [`[[${name}]]`, `[[${name}|`, `[[${name}#`];

	for (const page of wikiPages) {
		if (page.path.split("/").pop()!.replace(".md", "") === name) continue;
		if (searchPatterns.some(p => page.content.includes(p))) {
			const fileName = page.path.split("/").pop()!.replace(".md", "");
			results.push({ name: fileName, display: fileName });
		}
	}
	return results;
}

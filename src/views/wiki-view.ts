// Wiki 预览视图 -- 结构化浏览 + 内联页面预览 + 反向链接

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Component, Notice, TFile } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { openPluginSettings } from "../types";
import { readWikiFiles } from "../core/file-utils";
import { t } from "../core/i18n";
import { requirePro, showUpgradeNotice, createProBadge } from "../core/feature-gate";
import { renderGraph } from "./wiki-mindmap";

export const VIEW_TYPE_WIKI = "second-brain-wiki";

interface WikiPage {
	path: string;
	content: string;
}

interface IndexItem {
	name: string;
	display: string;
	desc: string;
}

interface IndexSection {
	title: string;
	subs: Array<{ title: string; items: IndexItem[] }>;
}


export class WikiView extends ItemView {
	/** @internal expose for mindmap module */
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

		const toggle = toolbar.createDiv({ cls: "sb-wiki-view-toggle" });
		this.indexBtn = toggle.createEl("button", { text: t("wiki.tabIndex", lang), cls: "sb-wiki-view-btn active" });
		const mocBtn = toggle.createEl("button", { text: "MOC", cls: "sb-wiki-view-btn" });
		this.graphBtn = toggle.createEl("button", { text: t("wiki.tabGraph", lang), cls: "sb-wiki-view-btn" });
		if (!requirePro(this.plugin.licenseInfo, "svg-mind-map")) {
			createProBadge(this.graphBtn, lang);
			this.graphBtn.classList.add("sb-pro-locked-btn");
		}
		this.indexBtn.addEventListener("click", () => this.showIndex());
		mocBtn.addEventListener("click", () => this.showMoc());
		this.graphBtn.addEventListener("click", () => this.showGraph());

		this.searchEl = toolbar.createEl("input", {
			attr: { placeholder: t("wiki.search", lang), type: "text" },
			cls: "sb-wiki-search",
		});

		// 排序下拉
		this.sortSelect = toolbar.createEl("select", { cls: "sb-wiki-sort" });
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

		const refreshBtn = toolbar.createEl("button", { text: t("wiki.refresh", lang), cls: "sb-wiki-refresh" });
		refreshBtn.addEventListener("click", () => this.loadWiki());

		const synthBtn = toolbar.createEl("button", { text: "\u7efc\u5408\u5206\u6790", cls: "sb-wiki-batch-btn" });
		synthBtn.addEventListener("click", () => this.openSynthesisDialog());
		const batchBtn = toolbar.createEl("button", { text: t("wiki.batchReview", lang), cls: "sb-wiki-batch-btn" });
		batchBtn.addEventListener("click", () => this.toggleBatchReview(batchBtn));

		this.bodyEl = container.createDiv({ cls: "sb-wiki-body" });
		this.searchEl.addEventListener("input", () => {
			if (this.currentView === "index") this.renderIndex();
		});

		await this.loadWiki();
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

	private async showMoc() {
		this.graphMode = false;
		this.currentView = "index";
		this.currentName = "";
		this.navHistory = [];
		this.indexBtn.classList.remove("active");
		this.indexBtn.parentElement?.querySelectorAll(".sb-wiki-view-btn").forEach(b => b.classList.remove("active"));
		this.bodyEl.empty();

		const lang = this.plugin.settings.language;
		const wf = this.plugin.settings.wikiFolder;
		const mocPages = this.wikiPages.filter(f => {
			const fmMatch = f.content.match(/^---\n[\s\S]*?\n---/);
			return fmMatch && /^type:\s*["']?moc["']?/m.test(fmMatch[0]);
		});

		this.bodyEl.createEl("h2", { text: "MOC — Map of Content", cls: "sb-wiki-h2" });
		this.bodyEl.createEl("p", { text: "MOC 是主题导航页，编译时不会被覆盖。你可以手动编辑它们来组织知识结构。", cls: "sb-wiki-card-desc" });

		const createBtn = this.bodyEl.createEl("button", { text: "+ 新建 MOC", cls: "sb-empty-btn mod-cta" });
		createBtn.style.marginBottom = "16px";
		createBtn.addEventListener("click", async () => {
			const name = "moc-" + Date.now();
			const today = new Date().toISOString().split("T")[0];
			const content = `---\ntitle: "New MOC"\ntype: moc\nstatus: "reviewed"\nlast_updated: ${today}\n---\n\n# New MOC\n\n> 在这里组织你的主题导航。使用 [[PageName]] 链接到相关页面。\n\n## 主题\n\n- [[ExamplePage]]\n`;
			const { writeWikiFile } = await import("../core/file-utils");
			await writeWikiFile(this.app, wf, `concepts/MOC/${name}.md`, content);
			new Notice("MOC 已创建");
			await this.loadWiki();
			this.showMoc();
		});

		if (mocPages.length === 0) {
			this.bodyEl.createEl("p", { text: "还没有 MOC 页面。点击上方按钮创建一个。", cls: "sb-wiki-empty" });
			return;
		}

		const grid = this.bodyEl.createDiv({ cls: "sb-wiki-grid" });
		for (const page of mocPages) {
			const name = page.path.split("/").pop()!.replace(".md", "");
			const card = grid.createDiv({ cls: "sb-wiki-card sb-wiki-card-reviewed" });
			const fmTitle = page.content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
			card.createEl("a", { text: fmTitle ? fmTitle[1] : name, cls: "sb-wiki-card-title" })
				.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(name); });
			const stripped = page.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
			const firstLine = stripped.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith(">")) || "";
			if (firstLine) card.createEl("p", { text: firstLine.slice(0, 120), cls: "sb-wiki-card-desc" });
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

	private extractLevel(content: string): string {
		const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
		if (!fmMatch) return "";
		const levelMatch = fmMatch[0].match(/^level:\s*["']?(.+?)["']?\s*$/m);
		return levelMatch ? levelMatch[1].trim() : "";
	}

	private extractType(content: string): string {
		const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
		if (!fmMatch) return "";
		const typeMatch = fmMatch[0].match(/^type:\s*["']?(.+?)["']?\s*$/m);
		return typeMatch ? typeMatch[1].trim() : "";
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
					const pageA = this.findPage(a.name);
					const pageB = this.findPage(b.name);
					const typeA = pageA ? this.extractType(pageA.content) : "";
					const typeB = pageB ? this.extractType(pageB.content) : "";
					return typeA.localeCompare(typeB) || a.display.localeCompare(b.display);
				}
				case "level": {
					const pageA = this.findPage(a.name);
					const pageB = this.findPage(b.name);
					const levelA = pageA ? this.extractLevel(pageA.content) : "";
					const levelB = pageB ? this.extractLevel(pageB.content) : "";
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

		// Pro 增强统计
		if (requirePro(this.plugin.licenseInfo, "svg-mind-map")) {
			const linkCount = this.wikiPages.reduce((sum, p) => {
				const matches = p.content.match(/\[\[([^\]]+)\]\]/g);
				return sum + (matches ? matches.length : 0);
			}, 0);
			stats.innerHTML += `<span class="sb-stat-item sb-stat-pro"><span class="sb-stat-num">${linkCount}</span><span class="sb-stat-label">${t("pro.stats.linkCount", lang, { n: linkCount })}</span></span>`;
		}

		// Recent updates timeline
		const recentPages = this.wikiPages
			.map(f => ({ name: f.path.split("/").pop()!.replace(".md", ""), date: this.extractUpdated(f.content) }))
			.filter(f => f.date)
			.sort((a, b) => b.date.localeCompare(a.date))
			.slice(0, 8);
		if (recentPages.length > 0) {
			const timeline = this.bodyEl.createDiv({ cls: "sb-wiki-timeline" });
			timeline.createEl("h3", { text: "\u6700\u8fd1\u66f4\u65b0", cls: "sb-wiki-h3" });
			for (const rp of recentPages) {
				const row = timeline.createDiv({ cls: "sb-wiki-timeline-row" });
				row.createEl("span", { text: rp.date, cls: "sb-wiki-timeline-date" });
				const link = row.createEl("a", { text: rp.name, cls: "sb-wiki-timeline-link" });
				link.addEventListener("click", (ev: Event) => { ev.preventDefault(); this.navigateTo(rp.name); });
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

				// 排序
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
					const tags = page ? this.extractTags(page.content) : [];

					// Draft/Review badge
					if (page) {
						const status = this.extractStatus(page.content);
						if (status === "draft") {
							card.classList.add("sb-wiki-card-draft");
							card.createEl("span", { text: t("wiki.statusDraft", lang), cls: "sb-wiki-status-badge sb-status-draft" });
						} else if (status === "reviewed") {
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

					if (tags.length > 0) {
						const tagRow = card.createDiv({ cls: "sb-wiki-card-tags" });
						for (const tag of tags.slice(0, 3)) {
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
			guidance.createEl("p", { text: t("empty.wikiDesc", lang) });
			const btnRow = guidance.createDiv({ cls: "sb-empty-btn-row" });
			const settingsBtn = btnRow.createEl("button", { text: t("empty.openSettings", lang), cls: "sb-empty-btn" });
			settingsBtn.addEventListener("click", () => {
				openPluginSettings(this.app);
			});
			const compileBtn = btnRow.createEl("button", { text: t("empty.startCompile", lang), cls: "sb-empty-btn mod-cta" });
			compileBtn.addEventListener("click", () => {
				this.plugin.activateView("second-brain-compile");
			});
			}

		// Load more button for large wikis
			if (this.wikiPages.length > this.pageLimit) {
				const loadMoreBtn = this.bodyEl.createEl("button", {
					text: `\u663e\u793a\u66f4\u591a (${this.wikiPages.length - this.pageLimit}+)`,
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
		const backBtn = breadcrumb.createEl("button", { text: t("wiki.back", lang), cls: "sb-wiki-back" });
		backBtn.addEventListener("click", () => this.goBack());
		breadcrumb.createEl("span", { text: name, cls: "sb-wiki-breadcrumb-title" });

		const editBtn = breadcrumb.createEl("button", { text: t("wiki.openEditor", lang), cls: "sb-wiki-edit-btn" });
		editBtn.addEventListener("click", () => this.openInEditor(name));

		const expressBtn = breadcrumb.createEl("button", { text: "\u751f\u6210\u6587\u7ae0", cls: "sb-wiki-edit-btn" });
		expressBtn.addEventListener("click", async () => {
			expressBtn.textContent = "...";
			try {
				const { callLLM } = await import("../core/llm");
				const { ensureFolder } = await import("../core/file-utils");
				const strippedContent = this.stripFrontmatter(page.content);
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
				expressBtn.textContent = "\u5df2\u751f\u6210";
			} catch (e) {
				expressBtn.textContent = "\u751f\u6210\u6587\u7ae0";
			}
		});

		// 页面元数据
		const metaRow = this.bodyEl.createDiv({ cls: "sb-wiki-meta" });
		const fmType = this.extractType(page.content);
		const fmLevel = this.extractLevel(page.content);
		const fmUpdated = this.extractUpdated(page.content);
		if (fmType) {
			const item = metaRow.createDiv({ cls: "sb-wiki-meta-item" });
			item.createEl("span", { text: t("wiki.metaType", lang), cls: "sb-wiki-meta-label" });
			item.createEl("span", { text: fmType });
		}
		if (fmLevel) {
			const item = metaRow.createDiv({ cls: "sb-wiki-meta-item" });
			item.createEl("span", { text: t("wiki.metaLevel", lang), cls: "sb-wiki-meta-label" });
			item.createEl("span", { text: fmLevel });
		}
		if (fmUpdated) {
			const item = metaRow.createDiv({ cls: "sb-wiki-meta-item" });
			item.createEl("span", { text: t("wiki.metaUpdated", lang), cls: "sb-wiki-meta-label" });
			item.createEl("span", { text: fmUpdated });
		}

		// 待审核横幅
		const status = this.extractStatus(page.content);
		if (status === "draft") {
			const banner = this.bodyEl.createDiv({ cls: "sb-draft-banner" });
			banner.createEl("span", { text: t("wiki.draft", lang), cls: "sb-draft-label" });
			const reviewBtn = banner.createEl("button", { text: t("wiki.markReviewed", lang), cls: "sb-draft-review-btn" });
			reviewBtn.addEventListener("click", async () => {
				await this.markAsReviewed(name);
				reviewBtn.textContent = t("wiki.reviewed", lang);
				banner.classList.remove("sb-draft-banner");
				banner.classList.add("sb-reviewed-banner");
				const label = banner.querySelector(".sb-draft-label");
				if (label) label.textContent = t("wiki.reviewed", lang);
			});
		} else if (status === "reviewed") {
			const banner = this.bodyEl.createDiv({ cls: "sb-reviewed-banner" });
			banner.createEl("span", { text: t("wiki.reviewed", lang), cls: "sb-draft-label" });
			const summaryBtn = banner.createEl("button", { text: "\u63d0\u70bc\u6458\u8981", cls: "sb-draft-review-btn" });
			summaryBtn.addEventListener("click", async () => {
				summaryBtn.textContent = "...";
				try {
					const { callLLM } = await import("../core/llm");
					const strippedContent = this.stripFrontmatter(page.content);
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
					summaryBtn.textContent = "\u5df2\u63d0\u70bc";
					summaryBtn.classList.add("mod-cta");
				} catch (e) {
					summaryBtn.textContent = "\u63d0\u70bc\u6458\u8981";
				}
			});
		}

		const contentEl = this.bodyEl.createDiv({ cls: "sb-wiki-page-content" });
		const stripped = this.stripFrontmatter(page.content);
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
				const chip = blGrid.createEl("a", { text: bl.display, cls: "sb-wiki-backlink-chip" });
				chip.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(bl.name); });
			}
		}
	}

	private extractUpdated(content: string): string {
		const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
		if (!fmMatch) return "";
		const updatedMatch = fmMatch[0].match(/^last_updated:\s*["']?(.+?)["']?\s*$/m);
		return updatedMatch ? updatedMatch[1].trim() : "";
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

	private extractTags(content: string): string[] {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
		if (!fmMatch) return [];
		const tagsLine = fmMatch[1].match(/tags:\s*\[([^\]]+)\]/);
		if (!tagsLine) return [];
		return tagsLine[1].split(",").map(t2 => t2.trim().replace(/['"]/g, "")).filter(Boolean);
	}

	private stripFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
	}
	private extractStatus(content: string): string {
		const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
		if (!fmMatch) return "";
		const statusMatch = fmMatch[0].match(/^status:\s*["']?(\w+)["']?\s*$/m);
		return statusMatch ? statusMatch[1] : "";
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
			const { writeLogEntry } = await import("../core/file-utils");
			await writeLogEntry(this.app, wf, "sync", `Reviewed: ${name}`);
		}
	}

	private findBacklinks(name: string): Array<{ name: string; display: string }> {
		const results: Array<{ name: string; display: string }> = [];
		const searchPatterns = [`[[${name}]]`, `[[${name}|`, `[[${name}#`];

		for (const page of this.wikiPages) {
			if (page.path.split("/").pop()!.replace(".md", "") === name) continue;
			const content = page.content;
			if (searchPatterns.some(p => content.includes(p))) {
				const fileName = page.path.split("/").pop()!.replace(".md", "");
				results.push({ name: fileName, display: fileName });
			}
		}
		return results;
	}

	private async openSynthesisDialog() {
		const lang = this.plugin.settings.language;
		const concepts = this.wikiPages
			.filter(f => f.path.includes("concepts/"))
			.map(f => ({ name: f.path.split("/").pop()!.replace(".md", ""), content: f.content }));

		const { Modal } = await import("obsidian");
		const modal = new Modal(this.app);
		modal.titleEl.setText("\u9009\u62e9 2-3 \u4e2a\u6982\u5ff5\u8fdb\u884c\u7efc\u5408\u5206\u6790");
		const container = modal.contentEl.createDiv();
		const checkboxes: Array<{ name: string; el: HTMLInputElement }> = [];

		for (const c of concepts.slice(0, 50)) {
			const label = container.createEl("label", { cls: "sb-synth-checkbox" });
			const cb = label.createEl("input", { attr: { type: "checkbox", value: c.name } });
			label.createSpan({ text: c.name });
			checkboxes.push({ name: c.name, el: cb });
		}

		const btnRow = container.createDiv({ cls: "sb-wizard-btn-row" });
		const genBtn = btnRow.createEl("button", { text: "\u751f\u6210", cls: "mod-cta" });
		genBtn.addEventListener("click", async () => {
			const selected = checkboxes.filter(c => c.el.checked).map(c => c.name);
			if (selected.length < 2) { genBtn.textContent = "\u81f3\u5c11\u9009 2 \u4e2a"; return; }
			genBtn.textContent = "...";
			try {
				const { callLLM } = await import("../core/llm");
				const { writeWikiFile } = await import("../core/file-utils");
				const relatedContent = selected.map(n => {
					const page = concepts.find(c => c.name === n);
					return page ? `=== ${n} ===\n${page.content.slice(0, 1500)}` : "";
				}).join("\n\n");
				const today = new Date().toISOString().split("T")[0];
				const result = await callLLM([
					{ role: "system", content: "Knowledge synthesis expert. Write a cross-concept analysis in the same language as the source material." },
					{ role: "user", content: `Analyze the deep connections between these concepts: ${selected.join(", ")}\n\n${relatedContent.slice(0, 12000)}\n\nWrite a synthesis page answering: How do these concepts relate, complement, or contradict each other?` },
				], this.plugin.settings, { maxTokens: 3000, temperature: 0.5 });
				const slug = selected.join("-").slice(0, 60);
				const page = `---\ntitle: "${slug}"\ntype: synthesis\nstatus: "draft"\nlast_updated: ${today}\n---\n\n${result.trim()}\n`;
				await writeWikiFile(this.app, this.plugin.settings.wikiFolder, `syntheses/${slug}.md`, page);
				modal.close();
				new Notice("\u7efc\u5408\u5206\u6790\u5df2\u751f\u6210");
				await this.loadWiki();
			} catch (e) {
				genBtn.textContent = "\u751f\u6210\u5931\u8d25";
			}
		});
		modal.open();
	}

	private toggleBatchReview(btn: HTMLButtonElement) {
		const lang = this.plugin.settings.language;
		if (this.batchMode) {
			this.batchMode = false;
			this.selectedPages.clear();
			if (this.batchBar) { this.batchBar.remove(); this.batchBar = null; }
			btn.textContent = t("wiki.batchReview", lang);
			this.renderIndex();
			return;
		}
		this.batchMode = true;
		this.selectedPages.clear();
		btn.textContent = t("wiki.batchReview", lang) + " *";
		this.renderIndex();

		if (this.batchBar) this.batchBar.remove();
		this.batchBar = this.bodyEl.createDiv({ cls: "sb-batch-bar" });
		const countEl = this.batchBar.createEl("span", { text: "0" });
		const applyBtn = this.batchBar.createEl("button", { text: t("wiki.batchReviewBtn", lang, { n: 0 }), cls: "mod-cta" });
		applyBtn.addEventListener("click", async () => {
			for (const name of this.selectedPages) {
				await this.markAsReviewed(name);
			}
			this.batchMode = false;
			this.selectedPages.clear();
			if (this.batchBar) { this.batchBar.remove(); this.batchBar = null; }
			btn.textContent = t("wiki.batchReview", lang);
			this.renderIndex();
		});

		this.bodyEl.querySelectorAll(".sb-wiki-card").forEach((cardEl: HTMLElement) => {
			const titleLink = cardEl.querySelector(".sb-wiki-card-title") as HTMLAnchorElement;
			if (!titleLink) return;
			const name = titleLink.textContent || "";
			const checkbox = cardEl.createEl("input", { cls: "sb-batch-checkbox", attr: { type: "checkbox" } });
			checkbox.addEventListener("change", () => {
				if ((checkbox as HTMLInputElement).checked) {
					this.selectedPages.add(name);
				} else {
					this.selectedPages.delete(name);
				}
				countEl.textContent = `${this.selectedPages.size}`;
				applyBtn.textContent = t("wiki.batchReviewBtn", lang, { n: this.selectedPages.size });
			});
		});
	}

	async onClose() {
		this.component.unload();
	}
}

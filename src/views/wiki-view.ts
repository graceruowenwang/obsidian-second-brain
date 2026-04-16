// Wiki 预览视图 — 结构化浏览 + 内联页面预览 + 反向链接

import { App, ItemView, WorkspaceLeaf, MarkdownRenderer, Component, Notice, TFile } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { readWikiFiles } from "../core/file-utils";

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
	plugin: SecondBrainPlugin;
	private bodyEl: HTMLElement;
	private searchEl: HTMLInputElement;
	private wikiPages: WikiPage[] = [];
	private indexData: IndexSection[] = [];
	private currentView: "index" | "page" = "index";
	private currentName = "";
	private navHistory: string[] = [];
	private component: Component;

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.component = new Component();
	}

	getViewType(): string { return VIEW_TYPE_WIKI; }
	getDisplayText(): string { return "Wiki 预览"; }
	getIcon(): string { return "globe"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.classList.add("second-brain-wiki");

		// 工具栏
		const toolbar = container.createDiv({ cls: "sb-wiki-toolbar" });
		this.searchEl = toolbar.createEl("input", {
			attr: { placeholder: "搜索概念、实体、来源...", type: "text" },
			cls: "sb-wiki-search",
		});

		const refreshBtn = toolbar.createEl("button", { text: "刷新", cls: "sb-wiki-refresh" });
		refreshBtn.addEventListener("click", () => this.loadWiki());

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

		this.currentView = "index";
		this.currentName = "";
		this.navHistory = [];
		this.renderIndex();
	}

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

	private renderIndex() {
		const query = (this.searchEl?.value || "").toLowerCase();
		this.bodyEl.empty();

		// 统计栏
		const cc = this.wikiPages.filter(f => f.path.includes("concepts/")).length;
		const ec = this.wikiPages.filter(f => f.path.includes("entities/")).length;
		const sc = this.wikiPages.filter(f => f.path.includes("sources/")).length;

		const stats = this.bodyEl.createDiv({ cls: "sb-wiki-stats" });
		stats.innerHTML = `<span class="sb-stat-num">${cc}</span><span class="sb-stat-label">概念</span>` +
			`<span class="sb-stat-sep">/</span>` +
			`<span class="sb-stat-num">${ec}</span><span class="sb-stat-label">实体</span>` +
			`<span class="sb-stat-sep">/</span>` +
			`<span class="sb-stat-num">${sc}</span><span class="sb-stat-label">来源</span>`;

		// 按分区渲染卡片
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
					// 提取标签
					const page = this.findPage(item.name);
					const tags = page ? this.extractTags(page.content) : [];

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
						for (const t of tags.slice(0, 3)) {
							tagRow.createEl("span", { text: t, cls: "sb-wiki-tag" });
						}
					}
				}
			}
		}

		// 搜索时额外匹配不在 index 中的文件
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
				this.bodyEl.createEl("h3", { text: "其他匹配", cls: "sb-wiki-h3" });
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
			this.bodyEl.createDiv({ cls: "sb-wiki-empty", text: "Wiki 为空，请先编译素材" });
		}
	}

	private async navigateTo(name: string) {
		this.navHistory.push(this.currentName);
		this.currentName = name;
		this.currentView = "page";
		await this.renderPage(name);
	}

	private async goBack() {
		const prev = this.navHistory.pop();
		if (prev) {
			this.currentName = prev;
			await this.renderPage(prev);
		} else {
			this.currentView = "index";
			this.currentName = "";
			this.renderIndex();
		}
	}

	private async renderPage(name: string) {
		this.bodyEl.empty();
		const page = this.findPage(name);
		if (!page) {
			this.bodyEl.createDiv({ cls: "sb-wiki-empty", text: `未找到: ${name}` });
			return;
		}

		// 面包屑导航
		const breadcrumb = this.bodyEl.createDiv({ cls: "sb-wiki-breadcrumb" });
		const backBtn = breadcrumb.createEl("button", { text: "< 返回", cls: "sb-wiki-back" });
		backBtn.addEventListener("click", () => this.goBack());
		breadcrumb.createEl("span", { text: name, cls: "sb-wiki-breadcrumb-title" });

		// 编辑按钮
		const editBtn = breadcrumb.createEl("button", { text: "在编辑器中打开", cls: "sb-wiki-edit-btn" });
		editBtn.addEventListener("click", () => this.openInEditor(name));

		// 页面内容区
		const contentEl = this.bodyEl.createDiv({ cls: "sb-wiki-page-content" });
		const stripped = this.stripFrontmatter(page.content);
		this.component.unload();
		this.component = new Component();
		await MarkdownRenderer.render(this.app, stripped, contentEl, "", this.component);

		// 处理双链点击 - 在预览内导航
		contentEl.querySelectorAll("a.internal-link").forEach((link: HTMLAnchorElement) => {
			const href = link.getAttribute("data-href") || link.getAttribute("href") || "";
			const targetName = href.split("/").pop()!.replace(".md", "").split("|")[0].split("#")[0];
			link.addEventListener("click", (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				this.navigateTo(targetName);
			});
		});

		// 反向链接
		const backlinks = this.findBacklinks(name);
		if (backlinks.length > 0) {
			this.bodyEl.createEl("h3", { text: "反向链接", cls: "sb-wiki-backlinks-title" });
			const blGrid = this.bodyEl.createDiv({ cls: "sb-wiki-backlinks-grid" });
			for (const bl of backlinks) {
				const chip = blGrid.createEl("a", { text: bl.display, cls: "sb-wiki-backlink-chip" });
				chip.addEventListener("click", (ev) => { ev.preventDefault(); this.navigateTo(bl.name); });
			}
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
		new Notice("文件未找到: " + name);
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
		return tagsLine[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
	}

	private stripFrontmatter(content: string): string {
		return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
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

	async onClose() {
		this.component.unload();
	}
}

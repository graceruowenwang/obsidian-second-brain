// Wiki 预览视图 — 结构化浏览 + 内联页面预览 + 反向链接 + 思维导图

import { ItemView, WorkspaceLeaf, MarkdownRenderer, Component, Notice, TFile } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { readWikiFiles } from "../core/file-utils";
import { t } from "../core/i18n";

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

interface MindMapNode {
	id: string;
	label: string;
	type: "root" | "category" | "page";
	level?: string;
	x: number;
	y: number;
	color: string;
	children: MindMapNode[];
}

const SVG_NS = "http://www.w3.org/2000/svg";

// key 用于路径匹配（固定中文目录名），label 运行时从 i18n 获取
const CATEGORIES: Array<{ key: string; color: string }> = [
	{ key: "核心概念", color: "#7c3aed" },
	{ key: "方法框架", color: "#0891b2" },
	{ key: "实践经验", color: "#ea580c" },
	{ key: "实体", color: "#059669" },
	{ key: "来源", color: "#6b7280" },
];

export class WikiView extends ItemView {
	plugin: SecondBrainPlugin;
	private bodyEl: HTMLElement;
	private searchEl: HTMLInputElement;
	private wikiPages: WikiPage[] = [];
	private indexData: IndexSection[] = [];
	private currentView: "index" | "page" | "graph" = "index";
	private currentName = "";
	private navHistory: string[] = [];
	private component: Component;
	private graphMode = false;
	private indexBtn: HTMLButtonElement;
	private graphBtn: HTMLButtonElement;

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
		this.graphBtn = toggle.createEl("button", { text: t("wiki.tabGraph", lang), cls: "sb-wiki-view-btn" });
		this.indexBtn.addEventListener("click", () => this.showIndex());
		this.graphBtn.addEventListener("click", () => this.showGraph());

		this.searchEl = toolbar.createEl("input", {
			attr: { placeholder: t("wiki.search", lang), type: "text" },
			cls: "sb-wiki-search",
		});

		const refreshBtn = toolbar.createEl("button", { text: t("wiki.refresh", lang), cls: "sb-wiki-refresh" });
		refreshBtn.addEventListener("click", () => this.loadWiki());

		this.bodyEl = container.createDiv({ cls: "sb-wiki-body" });
		this.searchEl.addEventListener("input", () => {
			if (this.currentView === "index") this.renderIndex();
		});

		await this.loadWiki();
	}

	private getCatLabel(key: string): string {
		return t(`wiki.cat.${key}`, this.plugin.settings.language);
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
			this.renderGraph();
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
		this.graphMode = true;
		this.currentView = "graph";
		this.currentName = "";
		this.navHistory = [];
		this.indexBtn.classList.remove("active");
		this.graphBtn.classList.add("active");
		this.renderGraph();
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
			this.bodyEl.createDiv({ cls: "sb-wiki-empty", text: t("wiki.empty", lang) });
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
			this.renderGraph();
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

	// --- 思维导图 ---

	private buildMindMapTree(): MindMapNode {
		const lang = this.plugin.settings.language;
		const groups: Record<string, MindMapNode[]> = {};
		for (const cat of CATEGORIES) groups[cat.key] = [];

		for (const page of this.wikiPages) {
			if (page.path === "index.md" || page.path.endsWith("/index.md")) continue;

			const name = page.path.split("/").pop()!.replace(/\.md$/, "");
			const fmMatch = page.content.match(/^---\n[\s\S]*?\ntitle:\s*["']?(.+?)["']?\s*$/m);
			const display = fmMatch ? fmMatch[1] : name;

			let catKey = "来源";
			if (page.path.includes("核心概念")) catKey = "核心概念";
			else if (page.path.includes("方法框架")) catKey = "方法框架";
			else if (page.path.includes("实践经验")) catKey = "实践经验";
			else if (page.path.includes("entities/")) catKey = "实体";

			const catDef = CATEGORIES.find(c => c.key === catKey)!;
			groups[catKey].push({
				id: name, label: display, type: "page",
				x: 0, y: 0, color: catDef.color, children: [],
			});
		}

		const root: MindMapNode = {
			id: "root", label: t("wiki.rootLabel", lang), type: "root",
			x: 0, y: 0, color: "", children: [],
		};

		for (const cat of CATEGORIES) {
			if (groups[cat.key].length === 0) continue;
			root.children.push({
				id: cat.key, label: this.getCatLabel(cat.key), type: "category",
				x: 0, y: 0, color: cat.color,
				children: groups[cat.key],
			});
		}

		return root;
	}

	private renderGraph() {
		this.bodyEl.empty();
		const lang = this.plugin.settings.language;

		const tree = this.buildMindMapTree();
		if (tree.children.length === 0) {
			this.bodyEl.createDiv({ cls: "sb-wiki-empty", text: t("wiki.empty", lang) });
			return;
		}

		// 图例
		const legend = this.bodyEl.createDiv({ cls: "sb-mmap-legend" });
		for (const cat of CATEGORIES) {
			if (!tree.children.some(c => c.id === cat.key)) continue;
			const el = legend.createDiv({ cls: "sb-mmap-legend-item" });
			el.createEl("span", { cls: "sb-mmap-legend-dot", attr: { style: `background:${cat.color}` } });
			el.createEl("span", { text: this.getCatLabel(cat.key) });
		}

		// 容器
		const mmapContainer = this.bodyEl.createDiv({ cls: "sb-mmap-container" });

		requestAnimationFrame(() => {
			const containerW = mmapContainer.clientWidth || 800;
			const totalLeaves = tree.children.reduce((s, c) => s + c.children.length, 0);
			const containerH = Math.max(400, Math.min(800, totalLeaves * 38 + 160));

			layoutMindMap(tree, containerW, containerH);

			const svg = document.createElementNS(SVG_NS, "svg");
			svg.setAttribute("viewBox", `0 0 ${containerW} ${containerH}`);
			svg.classList.add("sb-mmap-svg");
			mmapContainer.appendChild(svg);

			const g = document.createElementNS(SVG_NS, "g");
			g.classList.add("sb-mmap-group");
			svg.appendChild(g);

			// 连线
			for (const cat of tree.children) {
				mmapDrawBezier(g, tree.x, tree.y, cat.x, cat.y, cat.color, 2.5, cat.id);
				for (const page of cat.children) {
					mmapDrawBezier(g, cat.x, cat.y, page.x, page.y, cat.color, 1.5, cat.id, page.id);
				}
			}

			// 根节点
			mmapDrawRoot(g, tree);

			// 分类 + 页面节点
			for (const cat of tree.children) {
				mmapDrawCategory(g, cat);
				for (const page of cat.children) {
					mmapDrawPage(g, page, cat.color,
						(id: string) => this.navigateTo(id),
						(id: string) => this.highlightBranch(id, tree, svg),
						() => this.resetHighlight(svg),
					);
				}
			}

			this.setupMindMapInteraction(svg, g);
		});
	}

	private highlightBranch(pageId: string, tree: MindMapNode, svg: SVGSVGElement) {
		let targetCat: MindMapNode | null = null;
		for (const cat of tree.children) {
			if (cat.children.some(p => p.id === pageId)) { targetCat = cat; break; }
		}
		if (!targetCat) return;

		const keepIds = new Set<string>(["root", targetCat.id, pageId]);
		for (const p of targetCat.children) keepIds.add(p.id);

		svg.querySelectorAll(".sb-mmap-path").forEach(el => {
			const pe = el as SVGPathElement;
			const show = pe.dataset.catId === targetCat.id || pe.dataset.pageId === pageId;
			el.classList.toggle("dimmed", !show);
			el.classList.toggle("highlighted", show);
		});

		svg.querySelectorAll(".sb-mmap-node").forEach(el => {
			const nId = (el as SVGGElement).dataset.nodeId || "";
			el.classList.toggle("dimmed", !keepIds.has(nId));
		});
	}

	private resetHighlight(svg: SVGSVGElement) {
		svg.querySelectorAll(".sb-mmap-path, .sb-mmap-node").forEach(el => {
			el.classList.remove("highlighted", "dimmed");
		});
	}

	private setupMindMapInteraction(svg: SVGSVGElement, g: SVGGElement) {
		let scale = 1;
		let tx = 0;
		let ty = 0;
		let dragging = false;
		let sx = 0;
		let sy = 0;

		const update = () => {
			g.setAttribute("transform", `translate(${tx},${ty}) scale(${scale})`);
		};

		svg.addEventListener("wheel", (e) => {
			e.preventDefault();
			const f = e.deltaY > 0 ? 0.92 : 1.08;
			const ns = Math.max(0.3, Math.min(4, scale * f));
			const r = svg.getBoundingClientRect();
			const mx = e.clientX - r.left;
			const my = e.clientY - r.top;
			tx = mx - (mx - tx) * (ns / scale);
			ty = my - (my - ty) * (ns / scale);
			scale = ns;
			update();
		}, { passive: false });

		svg.addEventListener("mousedown", (e) => {
			if ((e.target as Element).closest(".sb-mmap-page-group")) return;
			dragging = true;
			sx = e.clientX - tx;
			sy = e.clientY - ty;
			svg.style.cursor = "grabbing";
		});

		const onMove = (e: MouseEvent) => {
			if (!dragging) return;
			tx = e.clientX - sx;
			ty = e.clientY - sy;
			update();
		};
		const onUp = () => { dragging = false; svg.style.cursor = "default"; };

		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		this.register(() => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		});
	}

	async onClose() {
		this.component.unload();
	}
}

// === 布局 ===

function layoutMindMap(root: MindMapNode, width: number, height: number) {
	root.x = width / 2;
	root.y = height / 2;
	if (root.children.length === 0) return;

	root.children.sort((a, b) => b.children.length - a.children.length);

	const mid = Math.ceil(root.children.length / 2);
	layoutSide(root.children.slice(0, mid), root.x, root.y, width, height, "right");
	layoutSide(root.children.slice(mid), root.x, root.y, width, height, "left");
}

function layoutSide(groups: MindMapNode[], rootX: number, _rootY: number, width: number, height: number, side: "left" | "right") {
	if (groups.length === 0) return;

	const dir = side === "right" ? 1 : -1;
	const halfW = width / 2 - 80;
	const catGap = Math.min(200, halfW * 0.45);
	const pageGap = Math.min(160, halfW * 0.35);
	const padY = 50;
	const totalH = height - padY * 2;

	const totalWeight = groups.reduce((s, g) => s + Math.max(1, g.children.length), 0);
	let curY = padY;

	for (const group of groups) {
		const w = Math.max(1, group.children.length);
		const groupH = (w / totalWeight) * totalH;

		group.x = rootX + dir * catGap;
		group.y = curY + groupH / 2;

		if (group.children.length > 0) {
			const spacing = groupH / (group.children.length + 1);
			for (let i = 0; i < group.children.length; i++) {
				group.children[i].x = group.x + dir * pageGap;
				group.children[i].y = curY + spacing * (i + 1);
			}
		}

		curY += groupH;
	}
}

// === SVG 绘制 ===

function mmapDrawBezier(
	g: SVGGElement, x1: number, y1: number, x2: number, y2: number,
	color: string, strokeW: number, catId?: string, pageId?: string,
) {
	const path = document.createElementNS(SVG_NS, "path");
	const cx = (x1 + x2) / 2;
	path.setAttribute("d", `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`);
	path.setAttribute("stroke", color);
	path.setAttribute("stroke-width", String(strokeW));
	path.setAttribute("fill", "none");
	path.setAttribute("opacity", "0.25");
	path.classList.add("sb-mmap-path");
	if (catId) path.dataset.catId = catId;
	if (pageId) path.dataset.pageId = pageId;
	g.appendChild(path);
}

function mmapDrawRoot(g: SVGGElement, node: MindMapNode) {
	const ng = document.createElementNS(SVG_NS, "g");
	ng.classList.add("sb-mmap-node");
	ng.dataset.nodeId = "root";

	const w = 80;
	const h = 36;
	const rect = document.createElementNS(SVG_NS, "rect");
	rect.setAttribute("x", String(node.x - w / 2));
	rect.setAttribute("y", String(node.y - h / 2));
	rect.setAttribute("width", String(w));
	rect.setAttribute("height", String(h));
	rect.setAttribute("rx", "18");
	rect.classList.add("sb-mmap-root-rect");
	ng.appendChild(rect);

	const text = document.createElementNS(SVG_NS, "text");
	text.setAttribute("x", String(node.x));
	text.setAttribute("y", String(node.y + 5));
	text.setAttribute("text-anchor", "middle");
	text.classList.add("sb-mmap-root-text");
	text.textContent = node.label;
	ng.appendChild(text);

	g.appendChild(ng);
}

function mmapDrawCategory(g: SVGGElement, node: MindMapNode) {
	const ng = document.createElementNS(SVG_NS, "g");
	ng.classList.add("sb-mmap-node");
	ng.dataset.nodeId = node.id;

	const charW = node.label.length <= 4 ? 18 : 14;
	const w = Math.max(60, node.label.length * charW + 24);
	const h = 30;

	const rect = document.createElementNS(SVG_NS, "rect");
	rect.setAttribute("x", String(node.x - w / 2));
	rect.setAttribute("y", String(node.y - h / 2));
	rect.setAttribute("width", String(w));
	rect.setAttribute("height", String(h));
	rect.setAttribute("rx", "15");
	rect.setAttribute("fill", node.color);
	ng.appendChild(rect);

	// 计数气泡
	if (node.children.length > 0) {
		const cR = 10;
		const cX = node.x + w / 2 + cR + 2;
		const cc = document.createElementNS(SVG_NS, "circle");
		cc.setAttribute("cx", String(cX));
		cc.setAttribute("cy", String(node.y));
		cc.setAttribute("r", String(cR));
		cc.setAttribute("fill", node.color);
		cc.setAttribute("opacity", "0.6");
		ng.appendChild(cc);

		const ct = document.createElementNS(SVG_NS, "text");
		ct.setAttribute("x", String(cX));
		ct.setAttribute("y", String(node.y + 4));
		ct.setAttribute("text-anchor", "middle");
		ct.setAttribute("fill", "#fff");
		ct.setAttribute("font-size", "10");
		ct.setAttribute("font-weight", "600");
		ct.textContent = String(node.children.length);
		ng.appendChild(ct);
	}

	const text = document.createElementNS(SVG_NS, "text");
	text.setAttribute("x", String(node.x));
	text.setAttribute("y", String(node.y + 5));
	text.setAttribute("text-anchor", "middle");
	text.setAttribute("fill", "#fff");
	text.setAttribute("font-size", "13");
	text.setAttribute("font-weight", "600");
	text.textContent = node.label;
	ng.appendChild(text);

	g.appendChild(ng);
}

function mmapDrawPage(
	g: SVGGElement, node: MindMapNode, catColor: string,
	onClick: (id: string) => void,
	onEnter: (id: string) => void,
	onLeave: () => void,
) {
	const ng = document.createElementNS(SVG_NS, "g");
	ng.classList.add("sb-mmap-node", "sb-mmap-page-group");
		ng.setAttribute("opacity", "0");
		ng.style.transition = "opacity 0.4s ease";
	ng.dataset.nodeId = node.id;

	const dot = document.createElementNS(SVG_NS, "circle");
	dot.setAttribute("cx", String(node.x));
	dot.setAttribute("cy", String(node.y));
	dot.setAttribute("r", "4");
	dot.setAttribute("fill", catColor);
	ng.appendChild(dot);

	const svgEl = g.closest("svg");
	const viewBox = svgEl?.getAttribute("viewBox")?.split(" ") || [];
	const centerX = viewBox.length >= 4 ? Number(viewBox[2]) / 2 : 400;
	const onRight = node.x > centerX;

	const label = node.label.length > 18 ? node.label.slice(0, 16) + "..." : node.label;

	const text = document.createElementNS(SVG_NS, "text");
	text.setAttribute("x", String(onRight ? node.x + 10 : node.x - 10));
	text.setAttribute("y", String(node.y + 4));
	text.setAttribute("text-anchor", onRight ? "start" : "end");
	text.classList.add("sb-mmap-page-text");
	text.textContent = label;
	ng.appendChild(text);

	// 隐形点击区域
	const textLen = label.length * 8 + 20;
	const hit = document.createElementNS(SVG_NS, "rect");
	hit.setAttribute("x", String(onRight ? node.x - 4 : node.x - textLen + 6));
	hit.setAttribute("y", String(node.y - 10));
	hit.setAttribute("width", String(textLen));
	hit.setAttribute("height", "20");
	hit.setAttribute("fill", "transparent");
	hit.classList.add("sb-mmap-hitarea");
	ng.appendChild(hit);

		// 拖拽支持
		let isDragging = false;
		let dragStartX = 0;
		let dragStartY = 0;
		let origX = node.x;
		let origY = node.y;
		ng.addEventListener("mousedown", (e: MouseEvent) => {
			if (e.button !== 0) return;
			isDragging = false;
			dragStartX = e.clientX;
			dragStartY = e.clientY;
			origX = node.x;
			origY = node.y;
			const onMove = (ev: MouseEvent) => {
				const dx = ev.clientX - dragStartX;
				const dy = ev.clientY - dragStartY;
				if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
					isDragging = true;
					ng.style.cursor = "grabbing";
				}
				if (isDragging) {
					e.preventDefault();
					const svgEl = g.closest("svg")!;
					const pt = svgEl.createSVGPoint();
					pt.x = ev.clientX; pt.y = ev.clientY;
					const ctm = g.getScreenCTM()!;
					const svgPt = pt.matrixTransform(ctm.inverse());
					const newX = svgPt.x;
					const newY = svgPt.y;
					// Move all children of the page group
					ng.querySelectorAll("circle, text, rect").forEach((el) => {
						const svgEl = el as SVGElement;
						for (const attr of ["cx", "x"]) {
							const v = svgEl.getAttribute(attr);
							if (v) svgEl.setAttribute(attr, String(Number(v) + (newX - origX)));
						}
						for (const attr of ["cy", "y"]) {
							const v = svgEl.getAttribute(attr);
							if (v) svgEl.setAttribute(attr, String(Number(v) + (newY - origY)));
						}
					});
					node.x = newX;
					node.y = newY;
				}
			};
			const onUp = () => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
				ng.style.cursor = "";
				if (isDragging) {
					// Suppress click after drag
					const suppressClick = (ce: MouseEvent) => { ce.stopPropagation(); ng.removeEventListener("click", suppressClick, true); };
					ng.addEventListener("click", suppressClick, true);
				}
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		});

	ng.addEventListener("click", () => onClick(node.id));
	ng.addEventListener("mouseenter", () => onEnter(node.id));
	ng.addEventListener("mouseleave", () => onLeave());

	g.appendChild(ng);
}

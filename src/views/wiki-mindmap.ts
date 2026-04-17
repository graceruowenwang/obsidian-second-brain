// Wiki 思维导图 -- SVG 渲染 + 交互 + 布局

import { t } from "../core/i18n";

interface Registerable {
	register(cb: () => void): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export interface MindMapNode {
	id: string;
	label: string;
	type: "root" | "category" | "page";
	level?: string;
	x: number;
	y: number;
	color: string;
	children: MindMapNode[];
}

export const CATEGORIES: Array<{ key: string; color: string }> = [
	{ key: "核心概念", color: "#7c3aed" },
	{ key: "方法框架", color: "#0891b2" },
	{ key: "实践经验", color: "#ea580c" },
	{ key: "实体", color: "#059669" },
	{ key: "来源", color: "#6b7280" },
];

export function getCatLabel(key: string, lang: string): string {
	return t(`wiki.cat.${key}`, lang);
}

export function buildMindMapTree(wikiPages: Array<{ path: string; content: string }>, lang: string): MindMapNode {
	const groups: Record<string, MindMapNode[]> = {};
	for (const cat of CATEGORIES) groups[cat.key] = [];

	for (const page of wikiPages) {
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
			id: cat.key, label: getCatLabel(cat.key, lang), type: "category",
			x: 0, y: 0, color: cat.color,
			children: groups[cat.key],
		});
	}

	return root;
}

export function renderGraph(view: Registerable, bodyEl: HTMLElement, wikiPages: Array<{ path: string; content: string }>, navigateTo: (id: string) => void, lang: string): void {
	bodyEl.empty();

	const tree = buildMindMapTree(wikiPages, lang);
	if (tree.children.length === 0) {
		bodyEl.createDiv({ cls: "sb-wiki-empty", text: t("wiki.empty", lang) });
		return;
	}

	const totalLeaves = tree.children.reduce((s, c) => s + c.children.length, 0);

	if (totalLeaves > 50) {
		renderSimplifiedGraph(bodyEl, tree, lang, view);
		return;
	}

	renderLegend(bodyEl, tree, lang);

	const mmapContainer = bodyEl.createDiv({ cls: "sb-mmap-container" });

	requestAnimationFrame(() => {
		const containerW = mmapContainer.clientWidth || 800;
		const containerH = Math.max(400, Math.min(800, totalLeaves * 38 + 160));

		layoutMindMap(tree, containerW, containerH);

		const svg = createSvg(containerW, containerH);
		mmapContainer.appendChild(svg);

		const g = createGroup();
		svg.appendChild(g);

		// 连线
		for (const cat of tree.children) {
			mmapDrawBezier(g, tree.x, tree.y, cat.x, cat.y, cat.color, 2.5, cat.id);
			for (const page of cat.children) {
				mmapDrawBezier(g, cat.x, cat.y, page.x, page.y, cat.color, 1.5, cat.id, page.id);
			}
		}

		mmapDrawRoot(g, tree);

		for (const cat of tree.children) {
			mmapDrawCategory(g, cat);
			for (const page of cat.children) {
				mmapDrawPage(g, page, cat.color,
					(id: string) => navigateTo(id),
					(id: string) => highlightBranch(id, tree, svg),
					() => resetHighlight(svg),
				);
			}
		}

		setupMindMapInteraction(view, svg, g);
	});
}

function renderSimplifiedGraph(bodyEl: HTMLElement, tree: MindMapNode, lang: string, view: Registerable): void {
	renderLegend(bodyEl, tree, lang);

	const mmapContainer = bodyEl.createDiv({ cls: "sb-mmap-container" });

	requestAnimationFrame(() => {
		const containerW = mmapContainer.clientWidth || 800;
		const containerH = 400;

		const svg = createSvg(containerW, containerH);
		mmapContainer.appendChild(svg);

		const g = createGroup();
		svg.appendChild(g);

		tree.x = containerW / 2;
		tree.y = containerH / 2;
		mmapDrawRoot(g, tree);

		const cats = tree.children;
		const angleStep = (2 * Math.PI) / cats.length;
		const radius = Math.min(containerW, containerH) * 0.32;

		for (let i = 0; i < cats.length; i++) {
			const cat = cats[i];
			cat.x = tree.x + radius * Math.cos(angleStep * i - Math.PI / 2);
			cat.y = tree.y + radius * Math.sin(angleStep * i - Math.PI / 2);

			mmapDrawBezier(g, tree.x, tree.y, cat.x, cat.y, cat.color, 2.5, cat.id);
			mmapDrawCategory(g, cat);
		}

		setupMindMapInteraction(view, svg, g);
	});
}

function renderLegend(container: HTMLElement, tree: MindMapNode, lang: string): void {
	const legend = container.createDiv({ cls: "sb-mmap-legend" });
	for (const cat of CATEGORIES) {
		if (!tree.children.some(c => c.id === cat.key)) continue;
		const el = legend.createDiv({ cls: "sb-mmap-legend-item" });
		el.createEl("span", { cls: "sb-mmap-legend-dot", attr: { style: `background:${cat.color}` } });
		el.createEl("span", { text: getCatLabel(cat.key, lang) });
	}
}

function createSvg(w: number, h: number): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
	svg.classList.add("sb-mmap-svg");
	return svg;
}

function createGroup(): SVGGElement {
	const g = document.createElementNS(SVG_NS, "g");
	g.classList.add("sb-mmap-group");
	return g;
}

function highlightBranch(pageId: string, tree: MindMapNode, svg: SVGSVGElement) {
	let targetCat: MindMapNode | null = null;
	for (const cat of tree.children) {
		if (cat.children.some(p => p.id === pageId)) { targetCat = cat; break; }
	}
	if (!targetCat) return;

	const keepIds = new Set<string>(["root", targetCat.id, pageId]);
	for (const p of targetCat.children) keepIds.add(p.id);

	svg.querySelectorAll(".sb-mmap-path").forEach(el => {
		const pe = el as SVGPathElement;
		const show = pe.dataset.catId === targetCat!.id || pe.dataset.pageId === pageId;
		el.classList.toggle("dimmed", !show);
		el.classList.toggle("highlighted", show);
	});

	svg.querySelectorAll(".sb-mmap-node").forEach(el => {
		const nId = (el as SVGGElement).dataset.nodeId || "";
		el.classList.toggle("dimmed", !keepIds.has(nId));
	});
}

function resetHighlight(svg: SVGSVGElement) {
	svg.querySelectorAll(".sb-mmap-path, .sb-mmap-node").forEach(el => {
		el.classList.remove("highlighted", "dimmed");
	});
}

function setupMindMapInteraction(view: Registerable, svg: SVGSVGElement, g: SVGGElement) {
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
	(view as any).register(() => {
		window.removeEventListener("mousemove", onMove);
		window.removeEventListener("mouseup", onUp);
	});
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

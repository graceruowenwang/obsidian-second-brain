// Wiki 视图共享类型和工具函数 -- 从 wiki-view.ts 拆分

import type { App } from "obsidian";
import { Modal, TFile } from "obsidian";
import type { SecondBrainPlugin } from "../types";

export interface WikiPage {
	path: string;
	content: string;
}

export interface IndexItem {
	name: string;
	display: string;
	desc: string;
}

export interface IndexSection {
	title: string;
	subs: Array<{ title: string; items: IndexItem[] }>;
}

/**
 * 解析 index.md 中的一条无序列表行（不要求 Obsidian 式 [[wikilink]]）。
 * 支持：`- [[name|display]]` / `- [[name]]`；`- [label](relative/path.md)`；`- 标题 — 描述`（分隔符为 —、-- 或 –）。
 */
export function parseWikiIndexListItem(line: string): IndexItem | null {
	const trimmed = line.trimEnd();
	const w = trimmed.match(/^-\s+\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*(?:[-\u2013\u2014]\s*)?(.*)$/);
	if (w) {
		const name = w[1].trim();
		const display = (w[2] || w[1]).trim();
		return { name, display, desc: (w[3] || "").trim() };
	}
	const md = trimmed.match(/^-\s+\[([^\]]*)\]\(([^)]+)\)\s*(?:[-\u2013\u2014]\s*)?(.*)$/);
	if (md) {
		const path = md[2].trim().replace(/\\/g, "/");
		const seg = path.split("/").pop() || "";
		const base = seg.replace(/\.md$/i, "").trim();
		const label = md[1].trim();
		const name = base || label;
		if (!name) return null;
		return { name, display: label || name, desc: (md[3] || "").trim() };
	}
	const plain = trimmed.match(/^-\s+((?!\[).+?)\s+(?:\u2014|--|–)\s+(.+)$/);
	if (plain) {
		const title = plain[1].replace(/\*\*/g, "").trim();
		if (!title) return null;
		return { name: title, display: title, desc: plain[2].trim() };
	}
	return null;
}

/** 去 # 锚点、统一为 /、去掉可选 .md，与 Obsidian 链名对齐 */
export function normalizeWikiPageKey(raw: string): string {
	let s = raw.trim().replace(/\\/g, "/");
	const h = s.indexOf("#");
	if (h >= 0) s = s.slice(0, h).trimEnd();
	if (s.toLowerCase().endsWith(".md")) s = s.slice(0, -3);
	return s.trim();
}

function wikiFileBase(rel: string): string {
	return rel.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/i, "");
}

/**
 * 将索引 / 内链里的名字解析到 wiki 文件列表。
 * 兼容：`[[Foo.md]]`、`[[Foo#heading]]`、路径链、与文件名大小写不一致等。
 */
export function resolveWikiPageByName(name: string, pages: WikiPage[]): WikiPage | undefined {
	const raw = name.trim().replace(/\\/g, "/");
	if (!raw) return undefined;
	const key = normalizeWikiPageKey(raw);
	for (const f of pages) {
		const rel = f.path.replace(/\\/g, "/");
		const base = wikiFileBase(rel);
		if (base === key) return f;
		if (rel === key || rel === `${key}.md`) return f;
	}
	const kl = key.toLowerCase();
	for (const f of pages) {
		const rel = f.path.replace(/\\/g, "/");
		const rlo = rel.toLowerCase();
		if (!key.includes("/")) {
			if (wikiFileBase(rel).toLowerCase() === kl) return f;
		} else if (rlo === `${kl}.md` || rlo === kl) {
			return f;
		}
	}
	return undefined;
}

/** 优先精确 path（含 concepts/x.md），再按链名解析；用于批量审核与导航 */
export function resolveWikiPageTarget(target: string, pages: WikiPage[]): WikiPage | undefined {
	const t = target.trim().replace(/\\/g, "/");
	if (!t) return undefined;
	const hitExact = pages.find(f => f.path.replace(/\\/g, "/") === t);
	if (hitExact) return hitExact;
	const noExt = t.replace(/\.md$/i, "");
	const hitNoExt = pages.find(f => f.path.replace(/\\/g, "/").replace(/\.md$/i, "") === noExt);
	if (hitNoExt) return hitNoExt;
	return resolveWikiPageByName(t, pages);
}

/** index.md 里有多少条不重复的链名在当前 wiki 文件列表中解析不到 */
export function countIndexUnresolvedLinks(indexData: IndexSection[], pages: WikiPage[]): number {
	const seen = new Set<string>();
	let missing = 0;
	for (const sec of indexData) {
		for (const sub of sec.subs) {
			for (const item of sub.items) {
				const nm = item.name.trim();
				if (!nm) continue;
				if (seen.has(nm)) continue;
				seen.add(nm);
				if (!resolveWikiPageTarget(nm, pages)) missing++;
			}
		}
	}
	return missing;
}

export interface WikiViewCtx {
	app: App;
	plugin: SecondBrainPlugin;
	bodyEl: HTMLElement;
	wikiPages: WikiPage[];
	currentView: "index" | "page";
	currentName: string;
	navHistory: string[];
	indexBtn: HTMLButtonElement;
	mocBtn: HTMLButtonElement;
	navigateTo(name: string): Promise<void>;
	loadWiki(): Promise<void>;
	extractType(content: string): string;
	extractLevel(content: string): string;
	extractTags(content: string): string[];
	/** `wikiRelPath`（如 concepts/a.md）或页面短名 */
	markAsReviewed(target: string): Promise<void>;
	markForRegeneration(target: string): Promise<void>;
	renderIndex(): void;
}

// Frontmatter 提取工具（兼容 \n 与 \r\n）
const FM_OPEN_CLOSE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquoteYamlScalar(raw: string): string {
	const v = raw.trim();
	if (!v) return "";
	if (v.startsWith('"') && v.endsWith('"')) {
		try {
			return JSON.parse(v) as string;
		} catch {
			return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
	}
	if (v.startsWith("'") && v.endsWith("'")) {
		return v.slice(1, -1).replace(/\\'/g, "'");
	}
	return v;
}

export function extractFmField(content: string, field: string): string {
	const fmMatch = content.match(FM_OPEN_CLOSE);
	if (!fmMatch) return "";
	for (const rawLine of fmMatch[1].split(/\r?\n/)) {
		const line = rawLine.replace(/\r$/, "").trimEnd();
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		if (key !== field) continue;
		return unquoteYamlScalar(line.slice(idx + 1));
	}
	return "";
}

export function extractTags(content: string): string[] {
	const fmMatch = content.match(FM_OPEN_CLOSE);
	if (!fmMatch) return [];
	const tagsLine = fmMatch[1].match(/tags:\s*\[([^\]]+)\]/);
	if (!tagsLine) return [];
	return tagsLine[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
}

export function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function extractStatus(content: string): string {
	return extractFmField(content, "status");
}

/** 用于比较：trim + 小写，避免 `Draft`、显式 `pending` 与列表/筛选不一致 */
export function wikiStatusNorm(content: string): string {
	return extractStatus(content).trim().toLowerCase();
}

/** 审核筛选用：待审队列（draft 或无 status）/ 已审 / 其余（gap、outdated 等） */
export type WikiReviewBucket = "pending" | "reviewed" | "other";

export function wikiReviewBucket(content: string): WikiReviewBucket {
	const s = wikiStatusNorm(content);
	if (s === "reviewed") return "reviewed";
	if (s === "draft" || s === "" || s === "pending") return "pending";
	return "other";
}

/**
 * Set YAML `status` in the first frontmatter block (insert line if missing).
 * Used by Wiki review / batch review so updates work without a strict regex on the old line.
 */
export function setWikiFrontmatterStatus(content: string, status: string): string {
	const safe = status.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	const quoted = `"${safe}"`;
	const fmMatch = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n*)/);
	if (!fmMatch) {
		return `---\nstatus: ${quoted}\n---\n\n${content}`;
	}
	const [, open, body, close] = fmMatch;
	const rest = content.slice(fmMatch[0].length);
	if (/^status:/m.test(body)) {
		const newBody = body.replace(/^status:\s*.+$/m, `status: ${quoted}`);
		return open + newBody + close + rest;
	}
	return `${open}status: ${quoted}\n${body}${close}${rest}`;
}

export function extractUpdated(content: string): string {
	return extractFmField(content, "last_updated");
}

/** 读取 frontmatter 中的 executive_summary（Wiki 提炼摘要） */
export function extractExecutiveSummary(content: string): string {
	const fmMatch = content.match(FM_OPEN_CLOSE);
	if (!fmMatch) return "";
	for (const line of fmMatch[1].split(/\r?\n/)) {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith("executive_summary:")) continue;
		let raw = trimmed.slice("executive_summary:".length).trim();
		if (raw.startsWith('"')) {
			try {
				return JSON.parse(raw) as string;
			} catch {
				return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
			}
		}
		if (raw.startsWith("'")) {
			return raw.slice(1, -1).replace(/\\'/g, "'");
		}
		return raw;
	}
	return "";
}

export function extractFmArray(content: string, field: string): string[] {
	const fmMatch = content.match(FM_OPEN_CLOSE);
	if (!fmMatch) return [];
	const lines = fmMatch[1].split(/\r?\n/);
	let inField = false;
	const items: string[] = [];
	for (const line of lines) {
		if (line.startsWith(`${field}:`)) {
			inField = true;
			const inline = line.slice(field.length + 1).trim();
			if (inline.startsWith("[")) {
				const parsed = inline.replace(/^\[/, "").replace(/\]$/, "").split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
				items.push(...parsed);
				return items;
			}
			continue;
		}
		if (inField) {
			const itemMatch = line.match(/^\s+-\s+["']?(.+?)["']?\s*$/);
			if (itemMatch) {
				items.push(itemMatch[1]);
			} else if (!line.match(/^\s/)) {
				break;
			}
		}
	}
	return items;
}

// ---- Shared Navigation & Dialog Helpers ----

/** 在 wiki 目录下按候选路径查找指定标题对应的文件 */
export function findWikiFile(app: App, wikiFolder: string, title: string): TFile | null {
	const candidates = [
		`${wikiFolder}/concepts/核心概念/${title}.md`,
		`${wikiFolder}/concepts/方法框架/${title}.md`,
		`${wikiFolder}/concepts/实践经验/${title}.md`,
		`${wikiFolder}/entities/${title}.md`,
		`${wikiFolder}/sources/${title}.md`,
		`${wikiFolder}/syntheses/${title}.md`,
		`${wikiFolder}/${title}.md`,
	];
	for (const p of candidates) {
		const file = app.vault.getAbstractFileByPath(p);
		if (file instanceof TFile) return file;
	}
	return null;
}

/** 通用确认对话框，返回 Promise<boolean> */
export function confirmDialog(
	app: App,
	opts: {
		title?: string;
		message: string;
		confirmText?: string;
		cancelText?: string;
		confirmClass?: string;
	},
): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		if (opts.title) modal.titleEl.setText(opts.title);
		modal.contentEl.createEl("p", { text: opts.message });
		const btnRow = modal.contentEl.createDiv();
		btnRow.style.display = "flex";
		btnRow.style.gap = "8px";
		btnRow.style.justifyContent = "flex-end";
		btnRow.createEl("button", {
			text: opts.cancelText || "Cancel",
		}).addEventListener("click", () => { modal.close(); resolve(false); });
		btnRow.createEl("button", {
			text: opts.confirmText || "Confirm",
			cls: opts.confirmClass || "mod-cta",
		}).addEventListener("click", () => { modal.close(); resolve(true); });
		modal.open();
	});
}

// Wiki 视图共享类型和工具函数 -- 从 wiki-view.ts 拆分

import type { App } from "obsidian";
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

/** 审核筛选用：待审队列（draft 或无 status）/ 已审 / 其余（gap、outdated 等） */
export type WikiReviewBucket = "pending" | "reviewed" | "other";

export function wikiReviewBucket(content: string): WikiReviewBucket {
	const s = extractStatus(content);
	if (s === "reviewed") return "reviewed";
	if (s === "draft" || s === "") return "pending";
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

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
	graphMode: boolean;
	currentView: "index" | "page" | "graph";
	currentName: string;
	navHistory: string[];
	indexBtn: HTMLButtonElement;
	navigateTo(name: string): Promise<void>;
	loadWiki(): Promise<void>;
	extractType(content: string): string;
	extractLevel(content: string): string;
	extractTags(content: string): string[];
	markAsReviewed(name: string): Promise<void>;
}

// Frontmatter 提取工具
export function extractFmField(content: string, field: string): string {
	const fmMatch = content.match(/^---\n[\s\S]*?\n---/);
	if (!fmMatch) return "";
	const match = fmMatch[0].match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m"));
	return match ? match[1].trim() : "";
}

export function extractTags(content: string): string[] {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return [];
	const tagsLine = fmMatch[1].match(/tags:\s*\[([^\]]+)\]/);
	if (!tagsLine) return [];
	return tagsLine[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
}

export function stripFrontmatter(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

export function extractStatus(content: string): string {
	return extractFmField(content, "status");
}

export function extractUpdated(content: string): string {
	return extractFmField(content, "last_updated");
}

export function extractFmArray(content: string, field: string): string[] {
	const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
	if (!fmMatch) return [];
	const lines = fmMatch[1].split("\n");
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

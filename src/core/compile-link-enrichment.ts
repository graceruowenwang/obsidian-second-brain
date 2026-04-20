// 智能补链 -- 编译后扫描 wiki 页面，发现跨页语义关联并自动补链

import { App } from "obsidian";
import { writeWikiFile, vectorSearch } from "./file-utils";
import { checkAborted, WIKILINK_RE, extractPageName, isSkippableWikiFile } from "./compile-analysis";
import type { PluginSettings } from "../types";
import type { TemplateConfig } from "./templates";

export interface LinkSuggestion {
	sourcePage: string;
	targetPage: string;
	targetDisplay: string;
	confidence: number;
}

export interface LinkEnrichmentResult {
	applied: number;
	enrichedPages: string[];
}

const CONFIDENCE_THRESHOLD = 0.5;
const MAX_SUGGESTIONS_PER_PAGE = 5;

function stripFrontmatter(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n*/, "");
}

interface PageIndex {
	graph: Map<string, Set<string>>;
	fileMap: Record<string, string>;
	eligible: Array<{ path: string; content: string }>;
}

function buildPageIndex(wikiFiles: Array<{ path: string; content: string }>): PageIndex {
	const graph = new Map<string, Set<string>>();
	const fileMap: Record<string, string> = {};
	const eligible: Array<{ path: string; content: string }> = [];

	for (const file of wikiFiles) {
		fileMap[file.path] = file.content;

		if (isSkippableWikiFile(file.path)) continue;

		const pageName = extractPageName(file.path);
		const linked = new Set<string>();

		let match: RegExpExecArray | null;
		WIKILINK_RE.lastIndex = 0;
		while ((match = WIKILINK_RE.exec(file.content)) !== null) {
			linked.add(match[1].trim());
		}

		graph.set(pageName, linked);
		eligible.push(file);
	}

	return { graph, fileMap, eligible };
}

async function findMissingLinks(
	pageName: string,
	pageContent: string,
	existingLinks: Set<string>,
	fileMap: Record<string, string>,
	settings: PluginSettings,
): Promise<LinkSuggestion[]> {
	const stripped = stripFrontmatter(pageContent);
	const query = stripped.slice(0, 500).replace(/[\n#*>\-|`\[\]]/g, " ").trim();
	if (query.length < 20) return [];

	try {
		const results = await vectorSearch(query, fileMap, settings, 10);
		const suggestions: LinkSuggestion[] = [];

		for (const r of results) {
			if (r.score < CONFIDENCE_THRESHOLD) continue;
			const targetName = extractPageName(r.filePath);
			if (targetName === pageName || existingLinks.has(targetName)) continue;
			if (targetName === "index" || targetName === "log") continue;

			suggestions.push({
				sourcePage: pageName,
				targetPage: targetName,
				targetDisplay: targetName,
				confidence: Math.round(r.score * 100) / 100,
			});

			if (suggestions.length >= MAX_SUGGESTIONS_PER_PAGE) break;
		}
		return suggestions;
	} catch {
		return [];
	}
}

function enrichPageWithLinks(
	content: string,
	suggestions: LinkSuggestion[],
	tpl: TemplateConfig,
): string {
	if (suggestions.length === 0) return content;

	const relatedHeader = tpl.relatedLinksHeader || "关联连接";
	const newLinks = suggestions.map(s => `- [[${s.targetPage}|${s.targetDisplay}]]`);
	const headerPattern = new RegExp(`^## ${escapeRegex(relatedHeader)}`, "m");

	if (headerPattern.test(content)) {
		const headerIdx = content.search(headerPattern);
		const afterHeader = content.indexOf("\n", headerIdx);
		const afterSection = content.indexOf("\n## ", afterHeader + 1);
		const insertPoint = afterSection === -1 ? content.length : afterSection;

		return content.slice(0, insertPoint).trimEnd() + "\n" + newLinks.join("\n") + "\n" +
			(afterSection === -1 ? "" : content.slice(afterSection));
	}

	return content.trimEnd() + "\n\n## " + relatedHeader + "\n\n" + newLinks.join("\n") + "\n";
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runLinkEnrichment(
	wikiFiles: Array<{ path: string; content: string }>,
	tpl: TemplateConfig,
	settings: PluginSettings,
	app: App,
	wikiFolder: string,
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
): Promise<LinkEnrichmentResult> {
	checkAborted(signal);

	// Skip when no embedding API configured (keyword fallback is too noisy for link suggestions)
	if (!settings.embeddingApiKey && !settings.apiKey) {
		return { applied: 0, enrichedPages: [] };
	}

	const { graph: linkGraph, fileMap, eligible } = buildPageIndex(wikiFiles);

	let applied = 0;
	const enrichedPages: string[] = [];

	for (let i = 0; i < eligible.length; i++) {
		checkAborted(signal);
		onProgress?.(i + 1, eligible.length);

		const file = eligible[i];
		const pageName = extractPageName(file.path);
		const existingLinks = linkGraph.get(pageName) || new Set();

		const suggestions = await findMissingLinks(pageName, file.content, existingLinks, fileMap, settings);
		if (suggestions.length === 0) continue;

		const enriched = enrichPageWithLinks(file.content, suggestions, tpl);
		if (enriched !== file.content) {
			await writeWikiFile(app, wikiFolder, file.path, enriched);
			applied += suggestions.length;
			enrichedPages.push(file.path);

			for (const s of suggestions) existingLinks.add(s.targetPage);
			linkGraph.set(pageName, existingLinks);
		}
	}

	return { applied, enrichedPages };
}

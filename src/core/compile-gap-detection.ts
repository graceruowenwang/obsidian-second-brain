// 知识缺口检测 -- 编译后扫描 wiki 页面，发现缺失的概念页面

import { App } from "obsidian";
import { writeWikiFile, deleteWikiFile } from "./file-utils";
import { frontmatter, today } from "./wiki-schema";
import { checkAborted, WIKILINK_RE, extractPageName, isSkippableWikiFile } from "./compile-analysis";
import type { Analysis, CompileCache } from "../types";
import type { TemplateConfig } from "./templates";

export interface KnowledgeGap {
	name: string;
	referencedBy: string[];
	referenceCount: number;
	context: string[];
	suggestedLevel: string;
}

export interface GapDetectionResult {
	gaps: KnowledgeGap[];
	stubsGenerated: number;
	stubPaths: string[];
}

const MAX_STUBS = 10;
const MIN_REFERENCE_COUNT = 2;

function suggestLevel(gap: KnowledgeGap): string {
	const hasCore = gap.referencedBy.some(p => p.includes("核心概念"));
	const hasPractice = gap.referencedBy.some(p => p.includes("实践经验"));
	if (hasCore) return "核心概念";
	if (hasPractice) return "实践经验";
	return "方法框架";
}

export function scanBrokenLinks(
	wikiFiles: Array<{ path: string; content: string }>,
	validNames: Set<string>,
): KnowledgeGap[] {
	const gapMap = new Map<string, KnowledgeGap>();

	for (const file of wikiFiles) {
		if (isSkippableWikiFile(file.path)) continue;

		let match: RegExpExecArray | null;
		WIKILINK_RE.lastIndex = 0;
		while ((match = WIKILINK_RE.exec(file.content)) !== null) {
			const pageName = match[1].trim();
			if (pageName.length < 2) continue;
			if (validNames.has(pageName)) continue;

			let gap = gapMap.get(pageName);
			if (!gap) {
				gap = { name: pageName, referencedBy: [], referenceCount: 0, context: [], suggestedLevel: "" };
				gapMap.set(pageName, gap);
			}
			if (!gap.referencedBy.includes(file.path)) {
				gap.referencedBy.push(file.path);
			}
			gap.referenceCount++;

			const start = Math.max(0, match.index - 25);
			const end = Math.min(file.content.length, match.index + match[0].length + 25);
			gap.context.push(file.content.slice(start, end).replace(/\n/g, " "));
		}
	}

	return Array.from(gapMap.values())
		.filter(g => g.referenceCount >= MIN_REFERENCE_COUNT)
		.sort((a, b) => b.referenceCount - a.referenceCount);
}

function generateStubPage(gap: KnowledgeGap, level: string, tpl: TemplateConfig): string {
	const fm = frontmatter({
		title: gap.name,
		type: "concept",
		level,
		status: "gap",
		tags: [gap.name],
		last_updated: today(),
	});

	const relatedLinks = gap.referencedBy.map(p => `- [[${extractPageName(p)}]]`);
	const relatedHeader = tpl.relatedLinksHeader || "关联连接";

	return `${fm}

> 此页面由知识缺口检测自动生成，等待后续编译补充内容。

${gap.name} 是一个待完善的概念，被 ${gap.referenceCount} 个页面引用。

## 来源引用

${relatedLinks.join("\n")}

## ${relatedHeader}

${relatedLinks.join("\n")}
`;
}

const UNSAFE_FILENAME_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const RESERVED_WIN = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

function sanitizeFilename(name: string): string {
	let s = name.replace(UNSAFE_FILENAME_RE, "_").trim().replace(/\.+$/, "");
	if (!s) s = "_untitled";
	if (RESERVED_WIN.test(s)) s = `_${s}`;
	if (s.length > 200) s = s.slice(0, 200);
	return s;
}

export async function runGapDetection(
	wikiFiles: Array<{ path: string; content: string }>,
	analysis: Analysis,
	tpl: TemplateConfig,
	app: App,
	wikiFolder: string,
	cache: CompileCache,
	signal?: AbortSignal,
): Promise<GapDetectionResult> {
	checkAborted(signal);

	// Clean up gap stubs that are now covered by real analysis concepts
	if (cache.gapPages) {
		const conceptNames = new Set((analysis.concepts || []).map(c => c.name));
		const entityNames = new Set((analysis.entities || []).map(e => e.name));
		const sourceNames = new Set((analysis.sources || []).map(s => s.name));
		const allReal = new Set([...conceptNames, ...entityNames, ...sourceNames]);
		for (const [name, info] of Object.entries(cache.gapPages)) {
			if (allReal.has(name)) {
				const levelDir = info.level || "方法框架";
				const stubPath = `concepts/${levelDir}/${sanitizeFilename(name)}.md`;
				try { await deleteWikiFile(app, wikiFolder, stubPath); } catch (e) { console.warn("gap-detection: failed to delete stale stub", stubPath, e); }
				delete cache.gapPages[name];
				if (cache.indexEntries) delete cache.indexEntries[name];
			}
		}
	}

	const validNames = new Set<string>();
	for (const c of (analysis.concepts || [])) {
		validNames.add(c.name);
		if (c.title && c.title !== c.name) validNames.add(c.title);
	}
	for (const e of (analysis.entities || [])) validNames.add(e.name);
	for (const s of (analysis.sources || [])) validNames.add(s.name);

	for (const f of wikiFiles) {
		validNames.add(extractPageName(f.path));
	}

	if (cache.gapPages) {
		for (const name of Object.keys(cache.gapPages)) {
			validNames.add(name);
		}
	}

	const gaps = scanBrokenLinks(wikiFiles, validNames);

	// compute level BEFORE using it for path
	for (const gap of gaps) {
		gap.suggestedLevel = suggestLevel(gap);
	}

	const topGaps = gaps.slice(0, MAX_STUBS);
	const stubsGenerated: string[] = [];

	for (const gap of topGaps) {
		checkAborted(signal);

		const levelDir = gap.suggestedLevel;
		const pagePath = `concepts/${levelDir}/${sanitizeFilename(gap.name)}.md`;

		if (wikiFiles.some(f => f.path === pagePath)) continue;

		const content = generateStubPage(gap, gap.suggestedLevel, tpl);
		await writeWikiFile(app, wikiFolder, pagePath, content);
		stubsGenerated.push(pagePath);

		if (!cache.indexEntries) cache.indexEntries = {};
		cache.indexEntries[gap.name] = {
			type: "concept",
			level: gap.suggestedLevel,
			name: gap.name,
			title: gap.name,
			desc: `缺口概念，被 ${gap.referenceCount} 个页面引用`,
		};

		if (!cache.gapPages) cache.gapPages = {};
		cache.gapPages[gap.name] = {
			name: gap.name,
			detectedAt: today(),
			referenceCount: gap.referenceCount,
			level: gap.suggestedLevel,
		};
	}

	return { gaps, stubsGenerated: stubsGenerated.length, stubPaths: stubsGenerated };
}

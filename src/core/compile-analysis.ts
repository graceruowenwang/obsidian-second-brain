// 编译分析 -- JSON 解析、Schema 校验、Diff 分析、后处理
// 从 compile-pages.ts 拆分

import type { Analysis, ValidationIssue } from "../types";
import type { TemplateConfig } from "./templates";
import { AnalysisSchema, parseAnalysisPartial } from "./schemas";
import { sanitizeLLMOutput } from "./sanitize";

export type AnalysisItem = {
	_type: "concept" | "entity" | "source";
	name: string;
	title?: string;
	level?: string;
	desc?: string;
	source_file?: string;
};

export function getPagePath(item: AnalysisItem): string {
	if (item._type === "concept") {
		const levelDir = item.level === "核心概念" ? "核心概念" : item.level === "实践经验" ? "实践经验" : "方法框架";
		return `concepts/${levelDir}/${item.name}.md`;
	} else if (item._type === "entity") {
		return `entities/${item.name}.md`;
	} else {
		return `sources/${item.name}.md`;
	}
}

export function checkAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("SB_CANCELLED");
}

// 健壮解析 LLM 返回的 JSON 分析结果（Zod 校验 + 部分恢复）
export function parseAnalysisJSON(raw: string): Analysis {
	const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
	const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		throw new Error("SB_NO_JSON");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonMatch[0]);
	} catch {
		throw new Error("SB_JSON_PARSE");
	}

	// 先尝试整体 strict parse
	const strictResult = AnalysisSchema.safeParse(parsed);
	if (strictResult.success) {
		const data = strictResult.data;
		const hasContent = data.concepts.length || data.entities.length
			|| data.sources.length || data.syntheses.length;
		if (hasContent) return data;
	}

	// 整体 parse 失败或结果为空，降级到逐字段部分恢复
	const partial = parseAnalysisPartial(parsed);
	const hasContent = partial.concepts.length || partial.entities.length
		|| partial.sources.length || partial.syntheses.length;
	if (!hasContent) {
		throw new Error("SB_EMPTY_ANALYSIS");
	}

	if (partial.issues.length > 0) {
		console.warn("parseAnalysisJSON: 部分恢复，跳过的字段:", partial.issues);
	}

	return {
		concepts: partial.concepts,
		entities: partial.entities,
		sources: partial.sources,
		syntheses: partial.syntheses,
	};
}

export function toTitleCase(s: string): string {
	return s.split(/[\s_-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
}

export function validateAnalysis(
	analysis: Analysis,
	rawFilePaths: Set<string>,
	tpl: TemplateConfig,
): { valid: Analysis; issues: ValidationIssue[] } {
	const issues: ValidationIssue[] = [];
	const validLevels = tpl.levels.map(l => l.key);
	const titleCaseRe = /^[A-Z][a-zA-Z0-9]*$/;

	const concepts = analysis.concepts.filter((c, i) => {
		if (!c.name || !c.name.trim()) { issues.push({ field: "concepts.name", index: i, issue: "empty name" }); return false; }
		if (!titleCaseRe.test(c.name)) {
			const fixed = toTitleCase(c.name);
			if (titleCaseRe.test(fixed)) {
				issues.push({ field: "concepts.name", index: i, issue: "auto-fixed to TitleCase", value: c.name });
				c.name = fixed;
			} else {
				issues.push({ field: "concepts.name", index: i, issue: "invalid TitleCase, skipped", value: c.name });
				return false;
			}
		}
		if (!c.title || !c.title.trim()) { c.title = c.name; }
		if (!validLevels.includes(c.level)) {
			issues.push({ field: "concepts.level", index: i, issue: `invalid level "${c.level}", defaulted`, value: c.level });
			c.level = validLevels[validLevels.length - 1];
		}
		if (c.source_file && !rawFilePaths.has(c.source_file)) {
			issues.push({ field: "concepts.source_file", index: i, issue: "source_file not found in raw/", value: c.source_file });
		}
		return true;
	});

	const entities = analysis.entities.filter((e, i) => {
		if (!e.name || !e.name.trim()) { issues.push({ field: "entities.name", index: i, issue: "empty name" }); return false; }
		return true;
	});

	const sources = analysis.sources.filter((s, i) => {
		if (!s.name || !s.name.trim()) { issues.push({ field: "sources.name", index: i, issue: "empty name" }); return false; }
		if (s.source_file && !rawFilePaths.has(s.source_file)) {
			issues.push({ field: "sources.source_file", index: i, issue: "source_file not found in raw/", value: s.source_file });
		}
		return true;
	});

	const conceptNames = new Set(concepts.map(c => c.name));
	const syntheses = analysis.syntheses.filter(syn => {
		syn.concepts = syn.concepts.filter(c => conceptNames.has(c));
		return syn.concepts.length >= 2;
	});

	return { valid: { concepts, entities, sources, syntheses }, issues };
}

export function ensureDraftStatus(content: string): string {
	const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n*)/);
	if (!fmMatch) {
		return `---\nstatus: "draft"\n---\n\n${content}`;
	}
	const [, open, body, close] = fmMatch;
	if (/^status:/m.test(body)) {
		return content.replace(/^(status:\s*).*$/m, '$1"draft"');
	}
	return `${open}status: "draft"\n${body}${close}`;
}

export function validateWikilinks(content: string, validPageNames: Set<string>): string {
	return content.replace(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g, (match, pageName) => {
		const trimmed = pageName.trim();
		if (validPageNames.has(trimmed)) return match;
		const displayMatch = match.match(/\[\[([^\]|]+)\|([^\]]+)\]\]/);
		return displayMatch ? displayMatch[2] : trimmed;
	});
}

export function postProcessPage(content: string, itemType: "concept" | "entity" | "source" | "synthesis", item: { name: string; title?: string; level?: string }, tpl: TemplateConfig, validPageNames: Set<string>): string {
	let page = sanitizeLLMOutput(content);
	const firstFm = page.indexOf("---");
	if (firstFm > 0) {
		page = page.slice(firstFm);
	}

	if (!page.startsWith("---")) {
		const TODAY = new Date().toISOString().split("T")[0];
			const safeTitle = (item.title || item.name).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
			const fm = `---\ntitle: "${safeTitle}"\ntype: ${itemType}\nstatus: "draft"\nlast_updated: ${TODAY}\n---\n\n`;
		page = fm + page;
	}

	page = ensureDraftStatus(page);

	if (itemType === "concept" && item.level) {
		const fmMatch = page.match(/^(---\n)([\s\S]*?)(\n---)/);
		if (fmMatch && !/^level:/m.test(fmMatch[2])) {
			page = `${fmMatch[1]}level: "${item.level}"\n${fmMatch[2]}${fmMatch[3]}` + page.slice(fmMatch[0].length);
		}
	}

	page = validateWikilinks(page, validPageNames);

	const relatedHeader = `## ${tpl.relatedLinksHeader}`;
	if (!page.includes(relatedHeader)) {
		const links = [...new Set([...page.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].trim()))];
		const linkSection = `\n\n${relatedHeader}\n${links.filter(n => n !== item.name).map(n => `- [[${n}]]`).join("\n")}`;
		page = page.trimEnd() + linkSection + "\n";
	}

	return page;
}

// 模糊去重
export function stringSimilarity(a: string, b: string): number {
	if (a === b) return 1.0;
	if (a.length === 0 || b.length === 0) return 0.0;
	const maxLen = Math.max(a.length, b.length);
	if (Math.abs(a.length - b.length) / maxLen > 0.4) return 0.0;
	const matrix: number[][] = [];
	for (let i = 0; i <= b.length; i++) matrix[i] = [i];
	for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
	for (let i = 1; i <= b.length; i++) {
		for (let j = 1; j <= a.length; j++) {
			const cost = b[i - 1] === a[j - 1] ? 0 : 1;
			matrix[i][j] = Math.min(
				matrix[i - 1][j] + 1,
				matrix[i][j - 1] + 1,
				matrix[i - 1][j - 1] + cost,
			);
		}
	}
	return 1 - matrix[b.length][a.length] / maxLen;
}

export function mergeAnalysis(oldAnalysis: Analysis | null, incremental: Analysis): Analysis {
	if (!oldAnalysis) return incremental;
	return {
		concepts: mergeByName(oldAnalysis.concepts || [], incremental.concepts || []),
		entities: mergeByName(oldAnalysis.entities || [], incremental.entities || []),
		sources: mergeByName(oldAnalysis.sources || [], incremental.sources || []),
		syntheses: mergeByName(oldAnalysis.syntheses || [], incremental.syntheses || []),
	};
}

function mergeByName<T extends { name: string }>(arr: T[], items: T[], fuzzyThreshold = 0.8): T[] {
	const result = [...arr];
	for (const item of items) {
		const exactIdx = result.findIndex(e => e.name === item.name);
		if (exactIdx >= 0) {
			result[exactIdx] = item;
			continue;
		}
		let bestIdx = -1;
		let bestScore = 0;
		for (let i = 0; i < result.length; i++) {
			const score = stringSimilarity(result[i].name.toLowerCase(), item.name.toLowerCase());
			if (score > bestScore && score >= fuzzyThreshold) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestIdx >= 0) {
			result[bestIdx] = { ...result[bestIdx], ...item, name: result[bestIdx].name };
		} else {
			result.push(item);
		}
	}
	return result;
}

// === 依赖图 ===

// 构建依赖图：每个 wiki 页面 → 依赖的 raw 文件 + 依赖的概念名
export function buildDependencyGraph(
	analysis: Analysis,
	allFiles: Array<{ path: string; content: string }>,
): Record<string, string[]> {
	const graph: Record<string, string[]> = {};
	const allNames = new Set([
		...analysis.concepts.map(c => c.name),
		...analysis.entities.map(e => e.name),
		...analysis.sources.map(s => s.name),
	]);

	// 建立概念名 → raw 文件的映射
	const nameToRawFiles: Record<string, Set<string>> = {};
	for (const c of analysis.concepts) {
		if (!nameToRawFiles[c.name]) nameToRawFiles[c.name] = new Set();
		if (c.source_file) nameToRawFiles[c.name].add(c.source_file);
	}
	for (const s of analysis.sources) {
		if (!nameToRawFiles[s.name]) nameToRawFiles[s.name] = new Set();
		if (s.source_file) nameToRawFiles[s.name].add(s.source_file);
	}

	// 也扫描 raw 文件内容中提及的概念名
	for (const f of allFiles) {
		for (const name of allNames) {
			if (f.content.includes(name)) {
				if (!nameToRawFiles[name]) nameToRawFiles[name] = new Set();
				nameToRawFiles[name].add(f.path);
			}
		}
	}

	// 为每个页面构建依赖列表
	const items: AnalysisItem[] = [
		...analysis.concepts.map(c => ({ ...c, _type: "concept" as const })),
		...analysis.entities.map(e => ({ ...e, _type: "entity" as const })),
		...analysis.sources.map(s => ({ ...s, _type: "source" as const })),
	];

	for (const item of items) {
		const pagePath = getPagePath(item);
		const deps = new Set<string>();

		// 直接 raw 文件依赖
		if (item.source_file) deps.add(item.source_file);


		// 扫描 raw 文件内容中包含当前概念名的文件
		for (const f of allFiles) {
			if (f.content.includes(item.name) || f.content.includes(item.title || "")) {
				deps.add(f.path);
			}
		}

		graph[pagePath] = [...deps];
	}

	return graph;
}

// 从依赖图做 BFS，找出所有受影响的页面
export function findAffectedPages(
	changedRawPaths: Set<string>,
	dependencies: Record<string, string[]>,
): Set<string> {
	const affected = new Set<string>();

	// 反向索引：raw 文件 → 依赖它的页面
	const rawToPages: Record<string, string[]> = {};
	for (const [pagePath, deps] of Object.entries(dependencies)) {
		for (const dep of deps) {
			if (!rawToPages[dep]) rawToPages[dep] = [];
			rawToPages[dep].push(pagePath);
		}
	}

	// BFS：从变化的 raw 文件出发
	const queue = [...changedRawPaths];
	const visited = new Set(changedRawPaths);

	while (queue.length > 0) {
		const current = queue.shift()!;
		const dependentPages = rawToPages[current] || [];
		for (const page of dependentPages) {
			if (!affected.has(page)) {
				affected.add(page);
				// 将页面也加入队列（处理页面间的传递依赖）
				if (!visited.has(page)) {
					visited.add(page);
					queue.push(page);
				}
			}
		}
	}

	return affected;
}

// === 共享工具（gap-detection / link-enrichment 使用） ===

export const WIKILINK_RE = /\[\[([^\]|/]+?)(?:\|[^\]]+?)?\]\]/g;

export function extractPageName(path: string): string {
	return path.split("/").pop()!.replace(".md", "");
}

export function isSkippableWikiFile(path: string): boolean {
	return path.endsWith("index.md") || path.endsWith("log.md") || path.includes(".cache/");
}

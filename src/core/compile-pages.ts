// 编译页面生成 -- 任务构建 + 素材检索 + 页面渲染

import { App, TFile } from "obsidian";
import { callLLM } from "./llm";
import { readWikiFiles, writeWikiFile, deleteWikiFile } from "./file-utils";
import {
	buildConceptPrompt, buildEntityPrompt, buildSourcePrompt, buildSynthesisPrompt,
} from "./wiki-schema";
import type { TemplateConfig } from "./templates";
import type { Analysis, CompileCache, ProgressEvent, Concept, Entity, Source, ValidationIssue, PluginSettings } from "../types";

const BATCH = 5;

type StorageLike = { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> };

function getStorage(app: App, plugin?: StorageLike): StorageLike {
	if (plugin) return plugin;
	return {
		loadData: () => (app as any).loadData(),
		saveData: (data: any) => (app as any).saveData(data),
	};
}

// 确保页面 frontmatter 中包含 status: "draft"
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

// 健壮解析 LLM 返回的 JSON 分析结果
export function parseAnalysisJSON(raw: string): Analysis {
	const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
	const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
	if (!jsonMatch) {
		return { concepts: [], entities: [], sources: [], syntheses: [] };
	}
	try {
		const parsed = JSON.parse(jsonMatch[0]);
		return {
			concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
			entities: Array.isArray(parsed.entities) ? parsed.entities : [],
			sources: Array.isArray(parsed.sources) ? parsed.sources : [],
			syntheses: Array.isArray(parsed.syntheses) ? parsed.syntheses : [],
		};
	} catch {
		return { concepts: [], entities: [], sources: [], syntheses: [] };
	}
}

// === Phase 1a: Schema 校验 ===

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

// === Phase 1b: Wikilink 存在性校验 ===

export function validateWikilinks(content: string, validPageNames: Set<string>): string {
	return content.replace(/\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g, (match, pageName) => {
		const trimmed = pageName.trim();
		if (validPageNames.has(trimmed)) return match;
		const displayMatch = match.match(/\[\[([^\]|]+)\|([^\]]+)\]\]/);
		return displayMatch ? displayMatch[2] : trimmed;
	});
}

// === Phase 1c: 确定性后处理 ===

export function postProcessPage(content: string, itemType: "concept" | "entity" | "source" | "synthesis", item: { name: string; title?: string; level?: string }, tpl: TemplateConfig, validPageNames: Set<string>): string {
	// 1. 去掉 LLM 前缀废话
	let page = content;
	const firstFm = page.indexOf("---");
	if (firstFm > 0) {
		page = page.slice(firstFm);
	}

	// 2. 确保 frontmatter 存在
	if (!page.startsWith("---")) {
		const TODAY = new Date().toISOString().split("T")[0];
		const fm = `---\ntitle: "${item.title || item.name}"\ntype: ${itemType}\nstatus: "draft"\nlast_updated: ${TODAY}\n---\n\n`;
		page = fm + page;
	}

	// 3. 确保关键 frontmatter 字段
	page = ensureDraftStatus(page);

	// 如果是 concept 且缺少 level 字段，补充
	if (itemType === "concept" && item.level) {
		if (!/^level:/m.test(page.split("---")[1] || "")) {
			page = page.replace(/^(---\n[\s\S]*?\n---)/, `$1\n`.replace("---", `---\nlevel: "${item.level}"`));
			// 更简单的方式：在 frontmatter 中插入
			const fmMatch = page.match(/^(---\n)([\s\S]*?)(\n---)/);
			if (fmMatch && !/^level:/m.test(fmMatch[2])) {
				page = `${fmMatch[1]}level: "${item.level}"\n${fmMatch[2]}${fmMatch[3]}` + page.slice(fmMatch[0].length);
			}
		}
	}

	// 4. 校验 wikilinks
	page = validateWikilinks(page, validPageNames);

	// 5. 确保 ## 关联连接 区块存在
	const relatedHeader = `## ${tpl.relatedLinksHeader}`;
	if (!page.includes(relatedHeader)) {
		// 从正文中提取所有 wikilink 作为关联连接
		const links = [...new Set([...page.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].trim()))];
		const linkSection = `\n\n${relatedHeader}\n${links.filter(n => n !== item.name).map(n => `- [[${n}]]`).join("\n")}`;
		page = page.trimEnd() + linkSection + "\n";
	}

	return page;
}

// === Phase 2a: 模糊去重 ===

export function stringSimilarity(a: string, b: string): number {
	if (a === b) return 1.0;
	if (a.length === 0 || b.length === 0) return 0.0;
	const maxLen = Math.max(a.length, b.length);
	if (Math.abs(a.length - b.length) / maxLen > 0.4) return 0.0;
	// Levenshtein distance
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

// 合并同名数组：新条目覆盖旧条目，新名称追加（支持模糊匹配）
function mergeByName<T extends { name: string }>(arr: T[], items: T[], fuzzyThreshold = 0.8): T[] {
	const result = [...arr];
	for (const item of items) {
		const exactIdx = result.findIndex(e => e.name === item.name);
		if (exactIdx >= 0) {
			result[exactIdx] = item;
			continue;
		}
		// 模糊匹配
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

// 合并旧分析 + 增量分析结果
export function mergeAnalysis(oldAnalysis: Analysis | null, incremental: Analysis): Analysis {
	if (!oldAnalysis) return incremental;
	return {
		concepts: mergeByName(oldAnalysis.concepts || [], incremental.concepts || []),
		entities: mergeByName(oldAnalysis.entities || [], incremental.entities || []),
		sources: mergeByName(oldAnalysis.sources || [], incremental.sources || []),
		syntheses: mergeByName(oldAnalysis.syntheses || [], incremental.syntheses || []),
	};
}

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

export function findRelevantMaterials(itemName: string, itemDesc: string, allFiles: Array<{ path: string; content: string }>, maxChars = 10000): string {
	const keywords: string[] = [];
	const titleWords = itemName.match(/[A-Z][a-z]+/g) || [];
	keywords.push(...titleWords);
	const segments = (itemDesc || "").split(/[,，、；;？?!！。\s]+/).filter(w => w.length >= 2 && w.length <= 8);
	keywords.push(...segments);
	const uniqueKw = [...new Set(keywords.filter(k => k.length >= 2))];
	if (uniqueKw.length === 0) uniqueKw.push(itemName);
	const kwLower = uniqueKw.map(k => k.toLowerCase());

	const fileInfos = allFiles.map(f => ({
		file: f,
		titleLow: f.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase(),
		headingsLow: (f.content.match(/^#{1,3}\s+(.+)$/gm) || []).join(" ").toLowerCase(),
		contentLow: f.content.toLowerCase(),
	}));

	const scored = fileInfos.map(info => {
		let score = 0;
		for (const kw of kwLower) {
			if (info.titleLow.includes(kw)) score += 8;
			if (info.headingsLow.includes(kw)) score += 5;
			if (info.contentLow.includes(kw)) score += 2;
		}
		return { file: info.file, score };
	});

	const relevant = scored.filter(s => s.score >= 3);
	relevant.sort((a, b) => b.score - a.score);

	let result = "";
	for (const { file, score } of relevant) {
		if (result.length >= maxChars) break;
		const sliceLen = score > 5 ? 3000 : 1500;
		result += `--- 文件: ${file.path} ---\n${file.content.slice(0, sliceLen)}\n\n`;
	}
	if (!result && allFiles.length > 0) {
		for (const f of allFiles.slice(0, 2)) {
			result += `--- 文件: ${f.path} ---\n${f.content.slice(0, 2000)}\n\n`;
		}
	}
	return result.slice(0, maxChars);
}

export interface Task {
	name: string;
	path: string;
	prompt: string;
	system: string;
	temp: number;
	item: AnalysisItem;
}

export function buildTask(item: AnalysisItem, allFiles: Array<{ path: string; content: string }>, concepts: Concept[], tpl: TemplateConfig): Task {
	const pagePath = getPagePath(item);
	const desc = item.desc || "";
	if (item._type === "concept") {
		const c = item as Concept;
		const materials = findRelevantMaterials(c.name, desc || c.title, allFiles, 10000);
		return { name: c.title || c.name, path: pagePath, prompt: buildConceptPrompt(c, materials, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.4, item };
	} else if (item._type === "entity") {
		const e = item as Entity;
		const materials = findRelevantMaterials(e.name, desc, allFiles, 8000);
		return { name: e.name, path: pagePath, prompt: buildEntityPrompt(e, materials, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.3, item };
	} else {
		const s = item as Source;
		let sourceContent = "";
		if (s.source_file) {
			const sourceFile = allFiles.find(f => f.path.includes(s.source_file));
			if (sourceFile) sourceContent = sourceFile.content.slice(0, 10000);
		}
		if (!sourceContent) sourceContent = findRelevantMaterials(s.name, desc, allFiles, 8000);
		return { name: s.name, path: pagePath, prompt: buildSourcePrompt(s, sourceContent, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.3, item };
	}
}

export function diffAnalysis(oldAnalysis: Analysis | null, newAnalysis: Analysis, changedFiles: Array<{ path: string; content: string }>): { regen: AnalysisItem[]; skip: AnalysisItem[]; remove: AnalysisItem[] } {
	if (!oldAnalysis) {
		return {
			regen: [
				...(newAnalysis.concepts || []).map(c => ({ ...c, _type: "concept" as const })),
				...(newAnalysis.entities || []).map(e => ({ ...e, _type: "entity" as const })),
				...(newAnalysis.sources || []).map(s => ({ ...s, _type: "source" as const })),
			],
			skip: [],
			remove: [],
		};
	}

	const oldMap = new Map<string, AnalysisItem>();
	for (const c of (oldAnalysis.concepts || [])) oldMap.set(c.name, { ...c, _type: "concept" });
	for (const e of (oldAnalysis.entities || [])) oldMap.set(e.name, { ...e, _type: "entity" });
	for (const s of (oldAnalysis.sources || [])) oldMap.set(s.name, { ...s, _type: "source" });

	const regen: AnalysisItem[] = [];
	const skip: AnalysisItem[] = [];
	const remove: AnalysisItem[] = [];
	const matchedOld = new Set<string>();

	const changedContent = changedFiles.map(f => f.content).join(" ");
	const changedPaths = changedFiles.map(f => f.path).join(" ");

	const allNew: AnalysisItem[] = [
		...(newAnalysis.concepts || []).map(c => ({ ...c, _type: "concept" as const })),
		...(newAnalysis.entities || []).map(e => ({ ...e, _type: "entity" as const })),
		...(newAnalysis.sources || []).map(s => ({ ...s, _type: "source" as const })),
	];

	for (const item of allNew) {
		matchedOld.add(item.name);
		const oldItem = oldMap.get(item.name);
		if (!oldItem) { regen.push(item); continue; }
		const itemTitle = item.title || item.name;
		const oldTitle = oldItem.title || oldItem.name;
		const fieldsMatch = item._type === oldItem._type &&
			itemTitle === oldTitle &&
			(item.level || "") === (oldItem.level || "") &&
			(item.desc || "") === (oldItem.desc || "");
		if (!fieldsMatch) { regen.push(item); continue; }
		const isAffected = changedContent.includes(item.name) || changedContent.includes(itemTitle) || changedPaths.includes(item.source_file || "");
		isAffected ? regen.push(item) : skip.push(item);
	}

	for (const [name, item] of oldMap) {
		if (!matchedOld.has(name)) remove.push(item);
	}

	return { regen, skip, remove };
}

export function checkAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("编译已取消");
}

export interface PageGenResult {
	errors: Array<{ name: string; path: string; error: string }>;
	generated: number;
	skippedByDiff: number;
	removed: number;
	protectedByReview: number;
}

export async function generatePages(
	newAnalysis: Analysis,
	oldAnalysis: Analysis | null,
	changedFiles: Array<{ path: string; content: string }>,
	allFiles: Array<{ path: string; content: string }>,
	tpl: TemplateConfig,
	settings: PluginSettings,
	cache: CompileCache,
	wikiFolder: string,
	app: App,
	onProgress: (e: ProgressEvent) => void,
	plugin?: { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> },
	signal?: AbortSignal,
): Promise<PageGenResult> {
	checkAborted(signal);

	const concepts = newAnalysis.concepts || [];
	const totalPages = concepts.length + (newAnalysis.entities?.length || 0) + (newAnalysis.sources?.length || 0);

	// 构建 validPageNames 用于 wikilink 校验
	const validPageNames = new Set<string>();
	for (const c of concepts) validPageNames.add(c.name);
	for (const e of (newAnalysis.entities || [])) validPageNames.add(e.name);
	for (const s of (newAnalysis.sources || [])) validPageNames.add(s.name);

	// Diff 分析
	const { regen, skip, remove } = diffAnalysis(oldAnalysis, newAnalysis, changedFiles);
	onProgress({ step: 3, stepName: "增量分析", detail: `新增/变化 ${regen.length}，跳过 ${skip.length}，删除 ${remove.length}`, percent: 45 });

	// 删除不再存在的页面，同步清理 indexEntries
	for (const item of remove) {
		const pagePath = getPagePath(item);
		if (cache.pages[pagePath]) {
			await deleteWikiFile(app, wikiFolder, pagePath);
			delete cache.pages[pagePath];
		}
		delete cache.indexEntries[pagePath];
		delete cache.failedPages[pagePath];
	}

	// Phase 4b: 保护已审核页面 -- reviewed 页面如果 source 没变化，不重新生成
	const changedPaths = new Set(changedFiles.map(f => f.path));

	// 因为需要 async 读取文件，不能用 filter
	const finalRegen: AnalysisItem[] = [];
	const syncProtected: AnalysisItem[] = [];
	for (const item of regen) {
		const pagePath = getPagePath(item);
		const existingFile = app.vault.getAbstractFileByPath(`${wikiFolder}/${pagePath}`);
		if (existingFile instanceof TFile) {
			try {
				const head = (await app.vault.cachedRead(existingFile)).slice(0, 500);
				if (/status:\s*["']?reviewed["']?/m.test(head)) {
					if (item.source_file && !changedPaths.has(item.source_file)) {
						syncProtected.push(item);
						continue;
					}
				}
			} catch {}
		}
		finalRegen.push(item);
	}

	// 重试失败页面 (Phase 2c)
	if (cache.failedPages) {
		for (const [path, entry] of Object.entries(cache.failedPages)) {
			if (entry.failCount < 3) {
				const existing = finalRegen.find(r => getPagePath(r as AnalysisItem) === path);
				if (!existing) {
					// 需要从 newAnalysis 中找到对应条目重试
					const allItems: AnalysisItem[] = [
						...(newAnalysis.concepts || []).map(c => ({ ...c, _type: "concept" as const })),
						...(newAnalysis.entities || []).map(e => ({ ...e, _type: "entity" as const })),
						...(newAnalysis.sources || []).map(s => ({ ...s, _type: "source" as const })),
					];
					const retryItem = allItems.find(i => getPagePath(i) === path);
					if (retryItem) finalRegen.push(retryItem);
				}
			}
		}
	}

	// 构建生成任务
	const tasks = finalRegen.map(item => buildTask(item, allFiles, concepts, tpl));
	let pagesDone = skip.length + syncProtected.length;
	const errors: Array<{ name: string; path: string; error: string }> = [];

	if (!cache.failedPages) cache.failedPages = {};

	// 批量生成概念/实体/来源页面
	for (let i = 0; i < tasks.length; i += BATCH) {
		checkAborted(signal);
		const batch = tasks.slice(i, i + BATCH);
		onProgress({ step: 3, stepName: "生成 wiki", detail: `生成中 (${batch.length} 个)...`, percent: 45 + Math.floor((i / Math.max(tasks.length, 1)) * 40), pagesDone, pagesTotal: totalPages });

		const results = await Promise.allSettled(batch.map(async (task) => {
			const raw = await callLLM([{ role: "system", content: task.system }, { role: "user", content: task.prompt }], settings, { temperature: task.temp, signal });
			const page = postProcessPage(raw, task.item._type, task.item, tpl, validPageNames);
			await writeWikiFile(app, wikiFolder, task.path, page);
			cache.pages[task.path] = { key: task.item.name, generatedAt: new Date().toISOString() };
			// 成功则清除失败记录
			delete cache.failedPages[task.path];
		}));

		for (let j = 0; j < results.length; j++) {
			if (results[j].status === "rejected") {
				const errMsg = (results[j] as PromiseRejectedResult).reason?.message || "未知错误";
				errors.push({ name: batch[j].name, path: batch[j].path, error: errMsg });
				// 记录失败 (Phase 2c)
				cache.failedPages[batch[j].path] = {
					name: batch[j].name,
					path: batch[j].path,
					error: errMsg,
					failCount: (cache.failedPages[batch[j].path]?.failCount || 0) + 1,
					lastFailedAt: new Date().toISOString(),
				};
			}
		}
		pagesDone += batch.length;
		await getStorage(app, plugin).saveData(cache);
	}

	// 批量生成 synthesis 页面
	const syntheses = newAnalysis.syntheses || [];
	if (syntheses.length > 0) {
		checkAborted(signal);
		onProgress({ step: 3, stepName: "生成综合分析", detail: `${syntheses.length} 个跨概念分析...`, percent: 88 });
		const wikiFiles = await readWikiFiles(app, wikiFolder);
		const conceptPages = wikiFiles
			.filter(f => f.path.includes("concepts/"))
			.map(f => ({ name: f.path.split("/").pop()!.replace(".md", ""), content: f.content }));

		for (let i = 0; i < syntheses.length; i += BATCH) {
			checkAborted(signal);
			const batch = syntheses.slice(i, i + BATCH);
			const synthResults = await Promise.allSettled(batch.map(async (synth) => {
				const synthPrompt = buildSynthesisPrompt(synth, concepts, conceptPages, tpl);
				const rawPage = await callLLM(
					[{ role: "system", content: tpl.synthesisEditorPrompt }, { role: "user", content: synthPrompt }],
					settings, { temperature: 0.5, signal },
				);
				const page = postProcessPage(rawPage, "synthesis", { name: synth.name }, tpl, validPageNames);
				await writeWikiFile(app, wikiFolder, `syntheses/${synth.name}.md`, page);
				delete cache.failedPages[`syntheses/${synth.name}.md`];
			}));
			for (let j = 0; j < synthResults.length; j++) {
				if (synthResults[j].status === "rejected") {
					const synth = batch[j];
					const errMsg = (synthResults[j] as PromiseRejectedResult).reason?.message || "未知错误";
					errors.push({ name: synth.name, path: `syntheses/${synth.name}.md`, error: errMsg });
					cache.failedPages[`syntheses/${synth.name}.md`] = {
						name: synth.name,
						path: `syntheses/${synth.name}.md`,
						error: errMsg,
						failCount: (cache.failedPages[`syntheses/${synth.name}.md`]?.failCount || 0) + 1,
						lastFailedAt: new Date().toISOString(),
					};
				}
			}
		}
		await getStorage(app, plugin).saveData(cache);
	}

	return {
		errors,
		generated: finalRegen.length - errors.length,
		skippedByDiff: skip.length,
		removed: remove.length,
		protectedByReview: syncProtected.length,
	};
}

// 编译引擎 — 从 compile-engine.js 移植
// 文件操作改为 Vault API，LLM 调用改为 requestUrl

import { App, Notice } from "obsidian";
import { callLLM } from "./llm";
import {
	readRawFiles, readWikiFiles, writeWikiFile, deleteWikiFile,
	diffFingerprints, updateFingerprints,
	totalAnalysisCount, emptyCache,
} from "./file-utils";
import {
	buildAnalyzePrompt, buildIncrementalAnalyzePrompt,
	buildConceptPrompt, buildEntityPrompt, buildSourcePrompt, buildSynthesisPrompt,
} from "./wiki-schema";
import { loadTemplateConfig } from "./templates";
import type { TemplateConfig } from "./templates";
import { t } from "./i18n";
import type { PluginSettings, Analysis, CompileCache, ProgressEvent, Concept, Entity, Source } from "../types";

const MAX_CHARS = 60000;

type StorageLike = { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> };

function getStorage(app: App, plugin?: StorageLike): StorageLike {
	if (plugin) return plugin;
	return {
		loadData: () => (app as any).loadData(),
		saveData: (data: any) => (app as any).saveData(data),
	};
}
const ANALYSIS_MAX_TOKENS = 4000;
const BATCH = 5;

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

// 合并同名数组：新条目覆盖旧条目，新名称追加
function mergeByName<T extends { name: string }>(arr: T[], items: T[]): T[] {
	const result = [...arr];
	for (const item of items) {
		const idx = result.findIndex(e => e.name === item.name);
		if (idx >= 0) result[idx] = item;
		else result.push(item);
	}
	return result;
}

// 合并旧分析 + 增量分析结果
function mergeAnalysis(oldAnalysis: Analysis | null, incremental: Analysis): Analysis {
	if (!oldAnalysis) return incremental;
	return {
		concepts: mergeByName(oldAnalysis.concepts || [], incremental.concepts || []),
		entities: mergeByName(oldAnalysis.entities || [], incremental.entities || []),
		sources: mergeByName(oldAnalysis.sources || [], incremental.sources || []),
		syntheses: mergeByName(oldAnalysis.syntheses || [], incremental.syntheses || []),
	};
}

type AnalysisItem = {
	_type: "concept" | "entity" | "source";
	name: string;
	title?: string;
	level?: string;
	desc?: string;
	source_file?: string;
};

function getPagePath(item: AnalysisItem): string {
	if (item._type === "concept") {
		const levelDir = item.level === "核心概念" ? "核心概念" : item.level === "实践经验" ? "实践经验" : "方法框架";
		return `concepts/${levelDir}/${item.name}.md`;
	} else if (item._type === "entity") {
		return `entities/${item.name}.md`;
	} else {
		return `sources/${item.name}.md`;
	}
}

function findRelevantMaterials(itemName: string, itemDesc: string, allFiles: Array<{ path: string; content: string }>, maxChars = 10000): string {
	const keywords: string[] = [];
	const titleWords = itemName.match(/[A-Z][a-z]+/g) || [];
	keywords.push(...titleWords);
	const segments = (itemDesc || "").split(/[,，、；;？?!！。\s]+/).filter(w => w.length >= 2 && w.length <= 8);
	keywords.push(...segments);
	const uniqueKw = [...new Set(keywords.filter(k => k.length >= 2))];
	if (uniqueKw.length === 0) uniqueKw.push(itemName);
	const kwLower = uniqueKw.map(k => k.toLowerCase());

	// 预计算每个 file 的 lowercase 信息，避免重复计算
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

interface Task {
	name: string;
	path: string;
	prompt: string;
	system: string;
	temp: number;
	item: AnalysisItem;
}

function buildTask(item: AnalysisItem, allFiles: Array<{ path: string; content: string }>, concepts: Concept[], tpl: TemplateConfig): Task {
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

function diffAnalysis(oldAnalysis: Analysis | null, newAnalysis: Analysis, changedFiles: Array<{ path: string; content: string }>): { regen: AnalysisItem[]; skip: AnalysisItem[]; remove: AnalysisItem[] } {
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

function checkAborted(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("编译已取消");
}

// === 步骤 1-2：读取素材 + AI 分析 ===

async function runAnalysis(
	allFiles: Array<{ path: string; content: string }>,
	changedFiles: Array<{ path: string; content: string }>,
	cache: CompileCache,
	tpl: TemplateConfig,
	settings: PluginSettings,
	forceRecompile: boolean,
	onProgress: (e: ProgressEvent) => void,
	signal?: AbortSignal,
): Promise<Analysis> {
	checkAborted(signal);

	const canIncremental = !forceRecompile && Object.keys(cache.perFileAnalysis || {}).length > 0 && changedFiles.length > 0 && changedFiles.length < allFiles.length;

	if (canIncremental) {
		onProgress({ step: 2, stepName: "AI 增量分析", detail: `分析 ${changedFiles.length} 个变化文件...`, percent: 30 });
		const existingNames = [...(cache.analysis?.concepts || []).map(c => c.name), ...(cache.analysis?.entities || []).map(e => e.name)];
		const changedMaterials = changedFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, 3000)}`).join("\n\n");
		if (!changedMaterials) {
			return cache.analysis!;
		}
		checkAborted(signal);
		const result = await callLLM(
			[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildIncrementalAnalyzePrompt(changedMaterials.slice(0, MAX_CHARS), existingNames, tpl) }],
			settings, { maxTokens: ANALYSIS_MAX_TOKENS, signal },
		);
		const incrementalResult = parseAnalysisJSON(result);
		if (incrementalResult.concepts.length === 0 && incrementalResult.entities.length === 0 && incrementalResult.sources.length === 0) {
			new Notice(t("notice.badAnalysis", settings.language));
			return cache.analysis!;
		}
		return mergeAnalysis(cache.analysis!, incrementalResult);
	}

	onProgress({ step: 2, stepName: "AI 分析素材", detail: "正在提取概念...", percent: 30 });
	const analysisMaterials = allFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, 2000)}`).join("\n\n");
	checkAborted(signal);
	const result = await callLLM(
		[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildAnalyzePrompt(analysisMaterials.slice(0, MAX_CHARS), tpl) }],
		settings, { maxTokens: ANALYSIS_MAX_TOKENS, signal },
	);
	const newAnalysis = parseAnalysisJSON(result);
	if (newAnalysis.concepts.length === 0 && newAnalysis.entities.length === 0 && newAnalysis.sources.length === 0) {
		throw new Error("AI 分析返回格式异常，请重试");
	}
	return newAnalysis;
}

// === 步骤 3：diff + 页面生成 ===

interface PageGenResult {
	errors: Array<{ name: string; path: string; error: string }>;
	generated: number;
	skippedByDiff: number;
	removed: number;
}

async function generatePages(
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
	}

	// 构建生成任务
	const tasks = regen.map(item => buildTask(item, allFiles, concepts, tpl));
	let pagesDone = skip.length;
	const errors: Array<{ name: string; path: string; error: string }> = [];

	// 批量生成概念/实体/来源页面
	for (let i = 0; i < tasks.length; i += BATCH) {
		checkAborted(signal);
		const batch = tasks.slice(i, i + BATCH);
		onProgress({ step: 3, stepName: "生成 wiki", detail: `生成中 (${batch.length} 个)...`, percent: 45 + Math.floor((i / Math.max(tasks.length, 1)) * 40), pagesDone, pagesTotal: totalPages });

		const results = await Promise.allSettled(batch.map(async (task) => {
			const raw = await callLLM([{ role: "system", content: task.system }, { role: "user", content: task.prompt }], settings, { temperature: task.temp, signal });
			const page = ensureDraftStatus(raw);
			await writeWikiFile(app, wikiFolder, task.path, page);
			cache.pages[task.path] = { key: task.item.name, generatedAt: new Date().toISOString() };
		}));

		for (let j = 0; j < results.length; j++) {
			if (results[j].status === "rejected") {
				errors.push({ name: batch[j].name, path: batch[j].path, error: (results[j] as PromiseRejectedResult).reason?.message || "未知错误" });
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
				const page = ensureDraftStatus(rawPage);
				await writeWikiFile(app, wikiFolder, `syntheses/${synth.name}.md`, page);
			}));
			for (let j = 0; j < synthResults.length; j++) {
				if (synthResults[j].status === "rejected") {
					const synth = batch[j];
					errors.push({ name: synth.name, path: `syntheses/${synth.name}.md`, error: (synthResults[j] as PromiseRejectedResult).reason?.message || "未知错误" });
				}
			}
		}
		await getStorage(app, plugin).saveData(cache);
	}

	return {
		errors,
		generated: regen.length - errors.length,
		skippedByDiff: skip.length,
		removed: remove.length,
	};
}

// === 步骤 4：生成 index.md ===

async function buildIndex(
	newAnalysis: Analysis,
	tpl: TemplateConfig,
	cache: CompileCache,
	wikiFolder: string,
	app: App,
): Promise<void> {
	const TODAY = new Date().toISOString().split("T")[0];
	const concepts = newAnalysis.concepts || [];
	const entities = newAnalysis.entities || [];
	const sources = newAnalysis.sources || [];
	const syntheses = newAnalysis.syntheses || [];

	// 重建 indexEntries（完全替换，避免过期条目）
	cache.indexEntries = {};
	for (const c of concepts) {
		cache.indexEntries[getPagePath({ ...c, _type: "concept" })] = { type: "concept", level: c.level || "", name: c.name, title: c.title || c.name, desc: c.desc || c.title || "" };
	}
	for (const e of entities) {
		cache.indexEntries[getPagePath({ ...e, _type: "entity" })] = { type: "entity", level: "", name: e.name, title: e.name, desc: e.desc || "" };
	}
	for (const s of sources) {
		cache.indexEntries[getPagePath({ ...s, _type: "source" })] = { type: "source", level: "", name: s.name, title: s.desc || s.name, desc: s.desc || "" };
	}
	for (const syn of syntheses) {
		cache.indexEntries[`syntheses/${syn.name}.md`] = { type: "synthesis", level: "", name: syn.name, title: syn.question || syn.name, desc: syn.question || "" };
	}

	// 从 indexEntries 构建 index.md
	const levels: Record<string, Array<{ name: string; title: string; desc: string }>> = {};
	const entityEntries: Array<{ name: string; desc: string }> = [];
	const sourceEntries: Array<{ name: string; desc: string }> = [];
	const synthEntries: Array<{ name: string; desc: string }> = [];

	for (const entry of Object.values(cache.indexEntries)) {
		if (entry.type === "concept") {
			const level = entry.level || "方法框架";
			if (!levels[level]) levels[level] = [];
			levels[level].push({ name: entry.name, title: entry.title, desc: entry.desc });
		} else if (entry.type === "entity") {
			entityEntries.push({ name: entry.name, desc: entry.desc });
		} else if (entry.type === "source") {
			sourceEntries.push({ name: entry.name, desc: entry.desc });
		} else if (entry.type === "synthesis") {
			synthEntries.push({ name: entry.name, desc: entry.desc });
		}
	}

	let indexContent = `---\ntitle: "Wiki Index"\ntype: index\nlast_updated: ${TODAY}\n---\n\n# Wiki Index\n\n## 概念体系\n\n`;
	for (const [level, items] of Object.entries(levels)) {
		if (items.length === 0) continue;
		indexContent += `### ${level} — ${(tpl.levels.find(l => l.key === level)?.desc || level)}\n\n`;
		for (const item of items) indexContent += `- [[${item.name}|${item.title}]] — ${item.desc}\n`;
		indexContent += "\n";
	}
	if (entityEntries.length) {
		indexContent += "## Entities\n\n";
		for (const e of entityEntries) indexContent += `- [[${e.name}]] — ${e.desc}\n`;
		indexContent += "\n";
	}
	if (sourceEntries.length) {
		indexContent += "## Sources\n\n";
		for (const s of sourceEntries) indexContent += `- [[${s.name}]] — ${s.desc}\n`;
		indexContent += "\n";
	}
	if (synthEntries.length) {
		indexContent += "## Syntheses\n\n";
		for (const s of synthEntries) indexContent += `- [[${s.name}]] — ${s.desc}\n`;
		indexContent += "\n";
	}

	await writeWikiFile(app, wikiFolder, "index.md", indexContent);
}

// === 主编译流程（编排函数） ===

export async function runCompile(
	app: App,
	settings: PluginSettings,
	onProgress: (e: ProgressEvent) => void = () => {},
	forceRecompile = false,
	plugin?: { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> },
	signal?: AbortSignal,
) {
	checkAborted(signal);
	const { rawFolder, wikiFolder } = settings;

	// 加载模板配置
	const tpl = await loadTemplateConfig(app, settings.templateFile, settings.language);

	// 步骤 1：读取素材
	onProgress({ step: 1, stepName: "读取素材", detail: "正在扫描...", percent: 15 });
	const allFiles = await readRawFiles(app, rawFolder);
	if (allFiles.length === 0) throw new Error(`${rawFolder}/ 目录为空`);

	// 加载缓存
	let cache: CompileCache = (await getStorage(app, plugin).loadData()) as CompileCache || emptyCache();
	if (!cache.fingerprints) cache = emptyCache();

	const { changed: changedFiles } = diffFingerprints(allFiles, cache);
	const hasChanges = changedFiles.length > 0;

	onProgress({ step: 1, stepName: "读取素材", detail: `${allFiles.length} 个文件，${hasChanges ? changedFiles.length + " 个有变化" : "全部未变化"}`, percent: 25 });

	if (!hasChanges && !forceRecompile && cache.analysis) {
		onProgress({ step: 2, stepName: "检查", detail: "素材无变化，跳过编译", percent: 100 });
		return { conceptsCount: cache.analysis.concepts?.length || 0, entitiesCount: cache.analysis.entities?.length || 0, sourcesCount: cache.analysis.sources?.length || 0, changed: 0, skippedByDiff: totalAnalysisCount(cache.analysis), generated: 0, errors: [], reused: true };
	}

	// 步骤 2：AI 分析
	const oldAnalysis = forceRecompile ? null : cache.analysis;
	const newAnalysis = await runAnalysis(allFiles, changedFiles, cache, tpl, settings, forceRecompile, onProgress, signal);

	cache.analysis = newAnalysis;
	cache.analysisTime = new Date().toISOString();
	const cc = newAnalysis.concepts?.length || 0;
	const ce = newAnalysis.entities?.length || 0;
	const cs = newAnalysis.sources?.length || 0;
	onProgress({ step: 2, stepName: "AI 分析", detail: `提取：${cc} 概念 + ${ce} 实体 + ${cs} 来源`, percent: 40 });

	// 步骤 3：diff + 页面生成
	const genResult = await generatePages(newAnalysis, oldAnalysis, changedFiles, allFiles, tpl, settings, cache, wikiFolder, app, onProgress, plugin, signal);

	// 步骤 4：生成索引
	onProgress({ step: 4, stepName: "生成索引", detail: "更新 index.md...", percent: 95 });
	await buildIndex(newAnalysis, tpl, cache, wikiFolder, app);

	// 更新指纹 + 保存
	updateFingerprints(allFiles, cache);
	await getStorage(app, plugin).saveData(cache);

	onProgress({ step: 4, stepName: "完成", detail: "编译完成", percent: 100 });

	return { conceptsCount: cc, entitiesCount: ce, sourcesCount: cs, changed: changedFiles.length, skippedByDiff: genResult.skippedByDiff, generated: genResult.generated, removed: genResult.removed, errors: genResult.errors, reused: false };
}

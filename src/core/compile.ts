// 编译引擎 — 从 compile-engine.js 移植
// 文件操作改为 Vault API，LLM 调用改为 requestUrl

import { App, Notice } from "obsidian";
import { callLLM } from "./llm";
import {
	readRawFiles, writeWikiFile,
	diffFingerprints, updateFingerprints,
	totalAnalysisCount, emptyCache, getStorage,
	restoreEmbeddingStore, flushEmbeddingStore, migrateEmbeddingsToStore,
} from "./file-utils";
import type { StorageLike } from "./file-utils";
import {
	buildAnalyzePrompt, buildIncrementalAnalyzePrompt,
} from "./wiki-schema";
import { loadTemplateConfig } from "./templates";
import type { TemplateConfig } from "./templates";
import { t } from "./i18n";
import type { PluginSettings, Analysis, CompileCache, ProgressEvent, ValidationIssue, CompileReport, ChangeImpact, CompileResult, CompileHistoryEntry, UsageStats } from "../types";
import { recordCompile, emptyStats } from "./usage-stats";
import { appendWeeklyReport } from "./weekly-report";

const MAX_CHARS = 60000;


const ANALYSIS_MAX_TOKENS = 4000;
import { parseAnalysisJSON, getPagePath, generatePages, checkAborted, PageGenResult, validateAnalysis, mergeAnalysis, runConflictDetection } from "./compile-pages";
import { buildDependencyGraph } from "./compile-analysis";
import { CompileLogBuilder, saveCompileLog } from "./compile-log";

// === 步骤 1-2：读取素材 + AI 分析 ===

interface AnalysisResult {
	analysis: Analysis;
	validationIssues: ValidationIssue[];
}

async function runAnalysis(
	allFiles: Array<{ path: string; content: string }>,
	changedFiles: Array<{ path: string; content: string }>,
	cache: CompileCache,
	tpl: TemplateConfig,
	settings: PluginSettings,
	forceRecompile: boolean,
	onProgress: (e: ProgressEvent) => void,
	signal?: AbortSignal,
): Promise<AnalysisResult> {
	checkAborted(signal);

	const rawFilePaths = new Set(allFiles.map(f => f.path));
	const canIncremental = !forceRecompile && Object.keys(cache.perFileAnalysis || {}).length > 0 && changedFiles.length > 0 && changedFiles.length < allFiles.length;

	if (canIncremental && cache.analysis && cache.analysis.concepts) {
		onProgress({ step: 2, stepName: "AI 增量分析", detail: `分析 ${changedFiles.length} 个变化文件...`, percent: 30 });
		const existingNames = [...(cache.analysis.concepts || []).map(c => c.name), ...(cache.analysis.entities || []).map(e => e.name)];
		const changedMaterials = changedFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, 3000)}`).join("\n\n");
		if (!changedMaterials) {
			return { analysis: cache.analysis, validationIssues: [] };
		}
		checkAborted(signal);
		const result = await callLLM(
			[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildIncrementalAnalyzePrompt(changedMaterials.slice(0, MAX_CHARS), existingNames, tpl) }],
			settings, { maxTokens: ANALYSIS_MAX_TOKENS, signal },
		);
		const incrementalResult = parseAnalysisJSON(result);
		const merged = mergeAnalysis(cache.analysis, incrementalResult);
		const { valid, issues } = validateAnalysis(merged, rawFilePaths, tpl);
		return { analysis: valid, validationIssues: issues };
	}

	onProgress({ step: 2, stepName: "AI 分析素材", detail: "正在提取概念...", percent: 30 });
	const analysisMaterials = allFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, 2000)}`).join("\n\n");
	checkAborted(signal);
	const result = await callLLM(
		[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildAnalyzePrompt(analysisMaterials.slice(0, MAX_CHARS), tpl) }],
		settings, { maxTokens: ANALYSIS_MAX_TOKENS, signal },
	);
	const parsed = parseAnalysisJSON(result);
	if (parsed.concepts.length === 0 && parsed.entities.length === 0 && parsed.sources.length === 0) {
		throw new Error("AI 分析返回格式异常，请重试");
	}
	const { valid, issues } = validateAnalysis(parsed, rawFilePaths, tpl);
	return { analysis: valid, validationIssues: issues };
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

// === Phase 3a: 编译报告构建 ===

function buildCompileReport(
	oldAnalysis: Analysis | null,
	newAnalysis: Analysis,
	genResult: PageGenResult,
	validationIssues: ValidationIssue[],
	startTime: number,
): CompileReport {
	const oldConceptMap = new Map((oldAnalysis?.concepts || []).map(c => [c.name, c]));
	const newConceptMap = new Map((newAnalysis.concepts || []).map(c => [c.name, c]));

	const newConcepts: CompileReport["newConcepts"] = [];
	const modifiedConcepts: CompileReport["modifiedConcepts"] = [];
	const deletedConcepts: CompileReport["deletedConcepts"] = [];

	for (const [name, c] of newConceptMap) {
		if (!oldConceptMap.has(name)) {
			newConcepts.push({ name, title: c.title || name, sourceFile: c.source_file || "" });
		} else {
			const old = oldConceptMap.get(name)!;
			const changes: string[] = [];
			if (old.desc !== c.desc) changes.push("description changed");
			if (old.level !== c.level) changes.push(`level: ${old.level} -> ${c.level}`);
			if (old.title !== c.title) changes.push("title changed");
			if (changes.length > 0) {
				modifiedConcepts.push({ name, title: c.title || name, changeSummary: changes.join("; ") });
			}
		}
	}

	for (const [name, old] of oldConceptMap) {
		if (!newConceptMap.has(name)) {
			deletedConcepts.push({ name, title: old.title || name });
		}
	}

	return {
		newConcepts,
		modifiedConcepts,
		deletedConcepts,
		validationIssues,
		totalPages: (newAnalysis.concepts?.length || 0) + (newAnalysis.entities?.length || 0) + (newAnalysis.sources?.length || 0),
		generatedPages: genResult.generated,
		skippedPages: genResult.skippedByDiff,
		failedPages: genResult.errors.length,
		protectedPages: genResult.protectedByReview,
		durationMs: Date.now() - startTime,
	};
}

// === Phase 5: 变更影响映射 ===

function buildChangeImpact(
	changedFiles: Array<{ path: string; content: string }>,
	analysis: Analysis,
): ChangeImpact[] {
	return changedFiles
		.filter(f => !f.path.includes("_usage"))
		.map(f => {
			const affected: ChangeImpact["affectedPages"] = [];
			for (const c of (analysis.concepts || [])) {
				if (f.path === c.source_file || f.content.includes(c.name) || f.content.includes(c.title || "")) {
					affected.push({ name: c.name, type: "concept" });
				}
			}
			for (const e of (analysis.entities || [])) {
				if (f.content.includes(e.name)) {
					affected.push({ name: e.name, type: "entity" });
				}
			}
			return { rawFile: f.path, affectedPages: affected };
		})
		.filter(imp => imp.affectedPages.length > 0);
}

// === 主编译流程（编排函数） ===

export async function runCompile(
	app: App,
	settings: PluginSettings,
	onProgress: (e: ProgressEvent) => void = () => {},
	forceRecompile = false,
	plugin?: { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> },
	signal?: AbortSignal,
): Promise<CompileResult> {
	checkAborted(signal);
	const startTime = Date.now();
	const { rawFolder, wikiFolder } = settings;

	// 初始化编译日志
	const logBuilder = new CompileLogBuilder(forceRecompile ? "full" : "incremental");

	// 加载模板配置
	const tpl = await loadTemplateConfig(app, settings.templateFile, settings.language);

	// 步骤 1：读取素材
	onProgress({ step: 1, stepName: "读取素材", detail: "正在扫描...", percent: 15 });
	const allFiles = await readRawFiles(app, rawFolder);
	if (allFiles.length === 0) throw new Error(`${rawFolder}/ 目录为空`);

	// 加载缓存
	let cache: CompileCache = (await getStorage(app, plugin).loadData()) as CompileCache || emptyCache();
		if (!cache.version || cache.version < 1) cache = emptyCache();
	if (!cache.fingerprints) cache = emptyCache();
	if (!cache.failedPages) cache.failedPages = {};
		if (!cache.dependencies) cache.dependencies = {};
		// v1→v2 迁移：embedding 移到独立文件
		if (cache.version < 2) {
			if ((cache as any).embeddings && Object.keys((cache as any).embeddings).length > 0) {
				await migrateEmbeddingsToStore(app, wikiFolder, cache as any);
			}
			delete (cache as any).embeddings;
			cache.version = 2;
		}

		// v2->v3: add compileHistory
		if (cache.version < 3) {
			if (!cache.compileHistory) cache.compileHistory = [];
			cache.version = 3;
		}
		await restoreEmbeddingStore(app, wikiFolder);

	const { changed: changedFiles } = diffFingerprints(allFiles, cache);
	const hasChanges = changedFiles.length > 0;

	onProgress({ step: 1, stepName: "读取素材", detail: `${allFiles.length} 个文件，${hasChanges ? changedFiles.length + " 个有变化" : "全部未变化"}`, percent: 25 });

	if (!hasChanges && !forceRecompile && cache.analysis) {
		onProgress({ step: 2, stepName: "检查", detail: "素材无变化，跳过编译", percent: 100 });
		return { conceptsCount: cache.analysis.concepts?.length || 0, entitiesCount: cache.analysis.entities?.length || 0, sourcesCount: cache.analysis.sources?.length || 0, changed: 0, skippedByDiff: totalAnalysisCount(cache.analysis), generated: 0, errors: [], reused: true, removed: 0, protectedByReview: 0 };
	}

	// 步骤 2：AI 分析
	const oldAnalysis = forceRecompile ? null : cache.analysis;
	const analysisResult = await runAnalysis(allFiles, changedFiles, cache, tpl, settings, forceRecompile, onProgress, signal);
	const newAnalysis = analysisResult.analysis;
	const validationIssues = analysisResult.validationIssues;

	const cc = newAnalysis.concepts?.length || 0;
	const ce = newAnalysis.entities?.length || 0;
	const cs = newAnalysis.sources?.length || 0;
	onProgress({ step: 2, stepName: "AI 分析", detail: `提取：${cc} 概念 + ${ce} 实体 + ${cs} 来源`, percent: 40 });

	// 步骤 3：diff + 页面生成
	const genResult = await generatePages(newAnalysis, oldAnalysis, changedFiles, allFiles, tpl, settings, cache, wikiFolder, app, onProgress, plugin, signal);

	// Phase 2b: 页面生成成功后才更新 cache.analysis
	cache.analysis = newAnalysis;
	cache.analysisTime = new Date().toISOString();

		// 更新依赖图
		cache.dependencies = buildDependencyGraph(newAnalysis, allFiles);

	// 步骤 4：生成索引
	onProgress({ step: 4, stepName: "生成索引", detail: "更新 index.md...", percent: 95 });
	await buildIndex(newAnalysis, tpl, cache, wikiFolder, app);

	// 更新指纹 + 保存
	updateFingerprints(allFiles, cache);
	await flushEmbeddingStore(app, wikiFolder);
	await getStorage(app, plugin).saveData(cache);

	onProgress({ step: 4, stepName: "完成", detail: "编译完成", percent: 100 });

	// 保存编译日志
	try {
		logBuilder.setTotalPages(cc + ce + cs)
			.setGenerated(genResult.generated)
			.setSkipped(genResult.skippedByDiff)
			.setProtected(genResult.protectedByReview)
			.setRemoved(genResult.removed);
		for (const err of genResult.errors) {
			logBuilder.addFailed(err.path, err.name, err.error);
		}
		const compileLog = logBuilder.build();
		await saveCompileLog(app, wikiFolder, compileLog);
	} catch (e) {
		console.warn("compile: failed to save compile log:", e);
	}

	// 构建编译报告
	const report = buildCompileReport(oldAnalysis, newAnalysis, genResult, validationIssues, startTime);
	const changeImpact = buildChangeImpact(changedFiles, newAnalysis);

	// Append compile history
	if (!cache.compileHistory) cache.compileHistory = [];
	cache.compileHistory.unshift({
		date: new Date().toISOString(),
		action: forceRecompile ? "full" : "incremental",
		added: report.newConcepts.map(c => c.title || c.name),
		modified: report.modifiedConcepts.map(c => c.title || c.name),
		removed: report.deletedConcepts.map(c => c.title || c.name),
		conflicts: [],
		durationMs: report.durationMs,
		totalPages: report.totalPages,
	});
	if (cache.compileHistory.length > 50) cache.compileHistory = cache.compileHistory.slice(0, 50);

	// 异步冲突检测（不阻塞编译结果返回）
	if (genResult.conflictCheckNeeded && genResult.conflictCheckNeeded.length > 0) {
		const conflictItems = genResult.conflictCheckNeeded;
		// fire-and-forget，编译结果先返回
		runConflictDetection(conflictItems, wikiFolder, app, settings, tpl, signal).catch(e => {
			console.warn("compile: async conflict detection failed:", e);
		});
	}

	return {
		conceptsCount: cc,
		entitiesCount: ce,
		sourcesCount: cs,
		changed: changedFiles.length,
		skippedByDiff: genResult.skippedByDiff,
		generated: genResult.generated,
		removed: genResult.removed,
		protectedByReview: genResult.protectedByReview,
		errors: genResult.errors,
		reused: false,
		report,
		changeImpact,
	};
}

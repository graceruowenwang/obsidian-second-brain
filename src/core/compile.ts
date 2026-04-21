// 编译引擎 — 从 compile-engine.js 移植
// 文件操作改为 Vault API，LLM 调用改为 requestUrl

import { App, TFolder } from "obsidian";
import { callLLM } from "./llm";
import {
	readRawFiles, readWikiFiles, writeWikiFile,
	diffFingerprints, updateFingerprints,
	totalAnalysisCount, emptyCache, getStorage,
	restoreEmbeddingStore, flushEmbeddingStore, migrateEmbeddingsToStore,
} from "./file-utils";
import {
	buildAnalyzePrompt, buildIncrementalAnalyzePrompt,
} from "./wiki-schema";
import { loadTemplateConfig } from "./templates";
import type { TemplateConfig } from "./templates";
import type { PluginSettings, Analysis, CompileCache, ProgressEvent, ValidationIssue, CompileReport, ChangeImpact, CompileResult } from "../types";
import { recordCompile, emptyStats } from "./usage-stats";
import { appendWeeklyReport } from "./weekly-report";
import {
	MAX_LLM_INPUT_CHARS, ANALYSIS_MAX_TOKENS, MAX_COMPILE_HISTORY,
	SLICE_INCREMENTAL_FILE, SLICE_FULL_ANALYSIS_FILE,
} from "./constants";

import { parseAnalysisJSON, getPagePath, generatePages, checkAborted, PageGenResult, validateAnalysis, mergeAnalysis } from "./compile-pages";
import { buildDependencyGraph } from "./compile-analysis";
import { CompileLogBuilder, saveCompileLog } from "./compile-log";
import { runGapDetection } from "./compile-gap-detection";
import { runLinkEnrichment } from "./compile-link-enrichment";

// === 缓存迁移 ===

// 同步迁移：纯字段结构变更。embedding 异步迁移由 runCompile 单独执行。
function migrateCache(cache: CompileCache): CompileCache {
	if (!cache.version || cache.version < 1) cache = emptyCache();
	if (!cache.fingerprints) cache = emptyCache();
	if (!cache.failedPages) cache.failedPages = {};
	if (!cache.dependencies) cache.dependencies = {};

	// v2→v3: 添加 compileHistory（与 v1→v2 的 embedding 异步迁移无依赖）
	if (cache.version < 3 && cache.version >= 2) {
		if (!cache.compileHistory) cache.compileHistory = [];
		cache.version = 3;
	}

	return cache;
}

// v1→v2 异步迁移：把 data.json 里的 embeddings 移到 wiki/.cache/embeddings.json
// 迁移成功后才删除 cache.embeddings 字段并升级版本号。
async function migrateEmbeddingsIfNeeded(
	app: App,
	wikiFolder: string,
	cache: CompileCache,
	settings: PluginSettings,
): Promise<void> {
	if (cache.version >= 2) return;
	const legacy = (cache as any).embeddings as Record<string, number[]> | undefined;
	if (legacy && Object.keys(legacy).length > 0) {
		try {
			await migrateEmbeddingsToStore(app, wikiFolder, cache as any, settings);
		} catch (e) {
			// 迁移失败：保留原字段，版本号不升级，下次 runCompile 再试
			console.warn("compile: embedding migration failed, will retry next run:", e);

			return;
		}
	}
	delete (cache as any).embeddings;
	cache.version = 2;

	// 顺延到 v3
	if (cache.version < 3) {
		if (!cache.compileHistory) cache.compileHistory = [];
		cache.version = 3;
	}
}

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
		const changedMaterials = changedFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, SLICE_INCREMENTAL_FILE)}`).join("\n\n");
		if (!changedMaterials) {
			return { analysis: cache.analysis, validationIssues: [] };
		}
		checkAborted(signal);
		const result = await callLLM(
			[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildIncrementalAnalyzePrompt(changedMaterials.slice(0, MAX_LLM_INPUT_CHARS), existingNames, tpl) }],
			settings, { maxTokens: ANALYSIS_MAX_TOKENS, signal },
		);
		const incrementalResult = parseAnalysisJSON(result);
		const merged = mergeAnalysis(cache.analysis, incrementalResult);
		const { valid, issues } = validateAnalysis(merged, rawFilePaths, tpl);
		return { analysis: valid, validationIssues: issues };
	}

	onProgress({ step: 2, stepName: "AI 分析素材", detail: "正在提取概念...", percent: 30 });
	const analysisMaterials = allFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, SLICE_FULL_ANALYSIS_FILE)}`).join("\n\n");
	checkAborted(signal);
	const result = await callLLM(
		[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildAnalyzePrompt(analysisMaterials.slice(0, MAX_LLM_INPUT_CHARS), tpl) }],
		settings, { maxTokens: ANALYSIS_MAX_TOKENS, signal },
	);
	const parsed = parseAnalysisJSON(result);
	if (parsed.concepts.length === 0 && parsed.entities.length === 0 && parsed.sources.length === 0) {
		throw new Error("SB_ANALYSIS_FORMAT");
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
	const gapEntries: Array<{ name: string; desc: string }> = [];

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
	// collect gap pages from cache
	if (cache.gapPages) {
		for (const [name, info] of Object.entries(cache.gapPages)) {
			gapEntries.push({ name, desc: `缺口概念，被 ${info.referenceCount} 个页面引用` });
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
	if (gapEntries.length) {
		indexContent += "## 待补充 (Gap)\n\n";
		for (const g of gapEntries) indexContent += `- [[${g.name}]] — ${g.desc}\n`;
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

// === 阶段函数 ===

interface CompileContext {
	app: App;
	settings: PluginSettings;
	plugin?: { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> };
	signal?: AbortSignal;
	onProgress: (e: ProgressEvent) => void;
	forceRecompile: boolean;
	startTime: number;

	// 阶段间共享状态
	cache: CompileCache;
	tpl: TemplateConfig;
	allFiles: Array<{ path: string; content: string }>;
	changedFiles: Array<{ path: string; content: string }>;
	oldAnalysis: Analysis | null;
	newAnalysis: Analysis | null;
	validationIssues: ValidationIssue[];
	genResult: PageGenResult | null;
	gapDetected: number;
	stubsGenerated: number;
	linksAdded: number;
	logBuilder: CompileLogBuilder;
}

/** 阶段 1: 加载素材和缓存 */
async function phaseLoad(ctx: CompileContext): Promise<void> {
	const { app, settings, onProgress, signal } = ctx;
	checkAborted(signal);

	// 加载模板配置
	ctx.tpl = await loadTemplateConfig(app, settings.templateFile, settings.language);

	// 读取素材
	onProgress({ step: 1, stepName: "读取素材", detail: "正在扫描...", percent: 15 });
	const rawDir = app.vault.getAbstractFileByPath(settings.rawFolder);
	if (!(rawDir instanceof TFolder)) {
		throw new Error("SB_RAW_MISSING");
	}
	const allFiles = await readRawFiles(app, settings.rawFolder);
	if (allFiles.length === 0) throw new Error("SB_RAW_NO_TEXT");
	ctx.allFiles = allFiles;

	// 加载并迁移缓存（分两步：同步结构迁移 + 异步 embedding 迁移）
	let cache = (await getStorage(app, ctx.plugin).loadData()) as CompileCache || emptyCache();
	cache = migrateCache(cache);
	await migrateEmbeddingsIfNeeded(app, settings.wikiFolder, cache, settings);
	await restoreEmbeddingStore(app, settings.wikiFolder, settings);
	ctx.cache = cache;

	// Diff 指纹
	const { changed } = diffFingerprints(allFiles, cache);
	ctx.changedFiles = changed;
	const hasChanges = changed.length > 0;
	onProgress({ step: 1, stepName: "读取素材", detail: `${allFiles.length} 个文件，${hasChanges ? changed.length + " 个有变化" : "全部未变化"}`, percent: 25 });
}

/** 阶段 2: AI 分析 */
async function phaseAnalyze(ctx: CompileContext): Promise<void> {
	const { cache, allFiles, changedFiles, tpl, settings, onProgress, signal } = ctx;
	checkAborted(signal);

	if (changedFiles.length === 0 && !ctx.forceRecompile && cache.analysis) {
		onProgress({ step: 2, stepName: "检查", detail: "素材无变化，跳过编译", percent: 100 });
		return;
	}

	ctx.oldAnalysis = ctx.forceRecompile ? null : cache.analysis;
	const analysisResult = await runAnalysis(allFiles, changedFiles, cache, tpl, settings, ctx.forceRecompile, onProgress, signal);
	ctx.newAnalysis = analysisResult.analysis;
	ctx.validationIssues = analysisResult.validationIssues;

	const cc = ctx.newAnalysis!.concepts?.length || 0;
	const ce = ctx.newAnalysis!.entities?.length || 0;
	const cs = ctx.newAnalysis!.sources?.length || 0;
	onProgress({ step: 2, stepName: "AI 分析", detail: `提取：${cc} 概念 + ${ce} 实体 + ${cs} 来源`, percent: 40 });
}

/** 阶段 3: 页面生成 */
async function phaseGenerate(ctx: CompileContext): Promise<void> {
	const { cache, allFiles, changedFiles, tpl, settings, oldAnalysis, newAnalysis, onProgress, signal } = ctx;
	checkAborted(signal);

	ctx.genResult = await generatePages(newAnalysis!, oldAnalysis, changedFiles, allFiles, tpl, settings, cache, settings.wikiFolder, ctx.app, onProgress, ctx.plugin, signal);

	// 页面生成成功后才更新 cache.analysis
	cache.analysis = newAnalysis;
	cache.analysisTime = new Date().toISOString();

	// Checkpoint：分析 + 指纹立即落盘，保护后续增强阶段失败时不丢主路径成果。
	// 这样即便 phaseEnrich 抛异常，下一次 runCompile 看到的指纹已是最新的，
	// 不会再重复花 token 跑全量分析。
	try {
		updateFingerprints(allFiles, cache);
		await getStorage(ctx.app, ctx.plugin).saveData(cache);
	} catch (e) {
		console.warn("compile: checkpoint save failed, continuing:", e);
	}
}

/** 阶段 4: 知识增强（缺口检测 + 补链） */
async function phaseEnrich(ctx: CompileContext): Promise<void> {
	const { cache, settings, newAnalysis, allFiles, onProgress, signal } = ctx;

	// 缺口检测
	ctx.gapDetected = 0;
	ctx.stubsGenerated = 0;
	if (!signal?.aborted && settings.enableGapDetection) {
		onProgress({ step: 3, stepName: "缺口检测", detail: "扫描知识缺口...", percent: 85 });
		const wikiFilesForGap = await readWikiFiles(ctx.app, settings.wikiFolder);
		const gapResult = await runGapDetection(wikiFilesForGap, newAnalysis!, ctx.tpl, ctx.app, settings.wikiFolder, cache, signal);
		ctx.gapDetected = gapResult.gaps.length;
		ctx.stubsGenerated = gapResult.stubsGenerated;
		ctx.logBuilder.setGapDetected(ctx.gapDetected, ctx.stubsGenerated);
	}

	// 智能补链
	ctx.linksAdded = 0;
	if (!signal?.aborted && settings.enableLinkEnrichment) {
		onProgress({ step: 3, stepName: "智能补链", detail: "发现语义连接...", percent: 90 });
		const wikiFilesForLink = await readWikiFiles(ctx.app, settings.wikiFolder);
		const linkResult = await runLinkEnrichment(
			wikiFilesForLink, ctx.tpl, settings, ctx.app, settings.wikiFolder,
			(done: number, total: number) => onProgress({ step: 3, stepName: "智能补链", detail: `${done}/${total} 页`, percent: 90 + Math.round((done / total) * 5) }),
			signal,
		);
		ctx.linksAdded = linkResult.applied;
		ctx.logBuilder.setLinksAdded(ctx.linksAdded);
	}

	// 更新依赖图
	cache.dependencies = buildDependencyGraph(newAnalysis!, allFiles);
}

/** 阶段 5: 索引生成 + 持久化 + 日志 */
async function phaseFinalize(ctx: CompileContext): Promise<CompileResult> {
	const { cache, settings, newAnalysis, changedFiles, allFiles, onProgress } = ctx;
	const wikiFolder = settings.wikiFolder;

	// 生成索引
	onProgress({ step: 4, stepName: "生成索引", detail: "更新 index.md...", percent: 95 });
	await buildIndex(newAnalysis!, ctx.tpl, cache, wikiFolder, ctx.app);

	// 更新指纹 + 保存缓存
	updateFingerprints(allFiles, cache);
	await flushEmbeddingStore(ctx.app, wikiFolder, settings);
	await getStorage(ctx.app, ctx.plugin).saveData(cache);

	onProgress({ step: 4, stepName: "完成", detail: "编译完成", percent: 100 });

	// 保存编译日志
	const cc = newAnalysis!.concepts?.length || 0;
	const ce = newAnalysis!.entities?.length || 0;
	const cs = newAnalysis!.sources?.length || 0;
	try {
		ctx.logBuilder.setTotalPages(cc + ce + cs)
			.setGenerated(ctx.genResult!.generated)
			.setSkipped(ctx.genResult!.skippedByDiff)
			.setProtected(ctx.genResult!.protectedByReview)
			.setRemoved(ctx.genResult!.removed);
		for (const err of ctx.genResult!.errors) {
			ctx.logBuilder.addFailed(err.path, err.name, err.error);
		}
		const compileLog = ctx.logBuilder.build();
		await saveCompileLog(ctx.app, wikiFolder, compileLog);
	} catch (e) {
		console.error("compile: failed to save compile log:", e);
	}

	// 构建编译报告
	const report = buildCompileReport(ctx.oldAnalysis, newAnalysis!, ctx.genResult!, ctx.validationIssues, ctx.startTime);
	const changeImpact = buildChangeImpact(changedFiles, newAnalysis!);

	// 追加编译历史
	if (!cache.compileHistory) cache.compileHistory = [];
	cache.compileHistory.unshift({
		date: new Date().toISOString(),
		action: ctx.forceRecompile ? "full" : "incremental",
		added: report.newConcepts.map(c => c.title || c.name),
		modified: report.modifiedConcepts.map(c => c.title || c.name),
		removed: report.deletedConcepts.map(c => c.title || c.name),
		conflicts: [],
		durationMs: report.durationMs,
		totalPages: report.totalPages,
	});
	if (cache.compileHistory.length > MAX_COMPILE_HISTORY) cache.compileHistory = cache.compileHistory.slice(0, MAX_COMPILE_HISTORY);

	// 记录使用统计
	if (!cache.usageStats) cache.usageStats = emptyStats();
	recordCompile(cache.usageStats, {
		success: ctx.genResult!.errors.length === 0,
		durationMs: report.durationMs,
		conceptsCount: cc,
		entitiesCount: ce,
	});

	// 每周知识报告（异步，不阻塞）
	appendWeeklyReport(ctx.app, wikiFolder, cache).catch(e => {
		console.error("compile: weekly report failed:", e);
	});

	return {
		conceptsCount: cc,
		entitiesCount: ce,
		sourcesCount: cs,
		changed: changedFiles.length,
		skippedByDiff: ctx.genResult!.skippedByDiff,
		generated: ctx.genResult!.generated,
		removed: ctx.genResult!.removed,
		protectedByReview: ctx.genResult!.protectedByReview,
		errors: ctx.genResult!.errors,
		reused: false,
		report,
		changeImpact,
		gapDetected: ctx.gapDetected,
		stubsGenerated: ctx.stubsGenerated,
		linksAdded: ctx.linksAdded,
	};
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

	const ctx: CompileContext = {
		app,
		settings,
		plugin,
		signal,
		onProgress,
		forceRecompile,
		startTime: Date.now(),
		cache: emptyCache(),
		tpl: {} as TemplateConfig,
		allFiles: [],
		changedFiles: [],
		oldAnalysis: null,
		newAnalysis: null,
		validationIssues: [],
		genResult: null,
		gapDetected: 0,
		stubsGenerated: 0,
		linksAdded: 0,
		logBuilder: new CompileLogBuilder(forceRecompile ? "full" : "incremental"),
	};

	// 阶段 1: 加载
	await phaseLoad(ctx);

	// 短路：无变化且不强制重编译
	if (ctx.changedFiles.length === 0 && !forceRecompile && ctx.cache.analysis) {
		onProgress({ step: 2, stepName: "检查", detail: "素材无变化，跳过编译", percent: 100 });
		return {
			conceptsCount: ctx.cache.analysis.concepts?.length || 0,
			entitiesCount: ctx.cache.analysis.entities?.length || 0,
			sourcesCount: ctx.cache.analysis.sources?.length || 0,
			changed: 0,
			skippedByDiff: totalAnalysisCount(ctx.cache.analysis),
			generated: 0,
			errors: [],
			reused: true,
			removed: 0,
			protectedByReview: 0,
		};
	}

	// 阶段 2: 分析
	await phaseAnalyze(ctx);

	// 阶段 3: 生成
	await phaseGenerate(ctx);

	// 阶段 4: 增强
	await phaseEnrich(ctx);

	// 阶段 5: 收尾
	return phaseFinalize(ctx);
}

// 编译引擎 — 从 compile-engine.js 移植
// 文件操作改为 Vault API，LLM 调用改为 requestUrl

import { App, Notice } from "obsidian";
import { callLLM } from "./llm";
import {
	readRawFiles, readWikiFiles, writeWikiFile, deleteWikiFile, writeLogEntry,
	findRelevantPages, diffFingerprints, updateFingerprints,
	totalAnalysisCount, simpleHash, emptyCache, filesToMap,
} from "./file-utils";
import {
	buildAnalyzePrompt, buildIncrementalAnalyzePrompt,
	buildConceptPrompt, buildEntityPrompt, buildSourcePrompt, buildSynthesisPrompt,
} from "./wiki-schema";
import { loadTemplateConfig, getLevelsDesc } from "./templates";
import { t } from "./i18n";
import type { PluginSettings, Analysis, CompileCache, ProgressEvent, Concept, Entity, Source, Synthesis } from "../types";
const MAX_CHARS = 60000;
const ANALYSIS_MAX_TOKENS = 4000;
const BATCH = 5;

// 确保页面 frontmatter 中包含 status: "draft"
function ensureDraftStatus(content: string): string {
	const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---\n*)/);
	if (!fmMatch) {
		// 没有 frontmatter，加一个
		return `---\nstatus: "draft"\n---\n\n${content}`;
	}
	const [, open, body, close] = fmMatch;
	if (/^status:/m.test(body)) {
		// 已有 status，替换为 draft
		return content.replace(/^(status:\s*).*$/m, '$1"draft"');
	}
	// 没有 status，插入到 frontmatter 第一行
	return `${open}status: "draft"\n${body}${close}`;
}

// 健壮解析 LLM 返回的 JSON 分析结果
function parseAnalysisJSON(raw: string): Analysis {
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

// 合并旧分析 + 增量分析结果
function mergeAnalysis(oldAnalysis: Analysis | null, incremental: Analysis): Analysis {
	if (!oldAnalysis) return incremental;
	const merged: Analysis = {
		concepts: [...(oldAnalysis.concepts || [])],
		entities: [...(oldAnalysis.entities || [])],
		sources: [...(oldAnalysis.sources || [])],
		syntheses: [...(oldAnalysis.syntheses || [])],
	};
	for (const type of ["concepts", "entities", "sources", "syntheses"] as const) {
		const existingNames = new Set(merged[type].map((item: any) => item.name));
		for (const item of (incremental[type] || [])) {
			if (existingNames.has((item as any).name)) {
				const idx = merged[type].findIndex((e: any) => e.name === (item as any).name);
				if (idx >= 0) merged[type][idx] = item;
			} else {
				merged[type].push(item);
			}
		}
	}
	return merged;
}

type AnalysisItem = (Concept & { _type: "concept" }) | (Entity & { _type: "entity" }) | (Source & { _type: "source" });

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

function extractDescription(content: string): string {
	const lines = content
		.replace(/^---\n[\s\S]*?\n---\n*/, "")
		.split("\n")
		.map(l => l.trim())
		.filter(l => l && !l.startsWith("#") && !l.startsWith("- ") && !l.startsWith(">"));
	if (lines.length === 0) return "";
	const first = lines[0].replace(/\*\*/g, "");
	const sentenceEnd = first.search(/[。？！.?!]/);
	return sentenceEnd > 0 ? first.slice(0, sentenceEnd + 1) : first.slice(0, 80);
}

function findRelevantMaterials(itemName: string, itemDesc: string, allFiles: Array<{ path: string; content: string }>, maxChars = 10000): string {
	const keywords: string[] = [];
	const titleWords = itemName.match(/[A-Z][a-z]+/g) || [];
	keywords.push(...titleWords);
	const segments = (itemDesc || "").split(/[,，、；;？?!！。\s]+/).filter(w => w.length >= 2 && w.length <= 8);
	keywords.push(...segments);
	const uniqueKw = [...new Set(keywords.filter(k => k.length >= 2))];
	if (uniqueKw.length === 0) uniqueKw.push(itemName);

	const scored = allFiles.map(f => {
		let score = 0;
		const fileTitle = f.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase();
		const headings = (f.content.match(/^#{1,3}\s+(.+)$/gm) || []).join(" ").toLowerCase();
		const contentLower = f.content.toLowerCase();
		for (const kw of uniqueKw) {
			const kwLower = kw.toLowerCase();
			if (fileTitle.includes(kwLower)) score += 8;
			if (headings.includes(kwLower)) score += 5;
			if (contentLower.includes(kwLower)) score += 2;
		}
		return { file: f, score };
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

function buildTask(item: AnalysisItem, allFiles: Array<{ path: string; content: string }>, concepts: Concept[]): Task {
	const pagePath = getPagePath(item);
	if (item._type === "concept") {
		const materials = findRelevantMaterials(item.name, item.desc || item.title, allFiles, 10000);
		return { name: item.title || item.name, path: pagePath, prompt: buildConceptPrompt(item, materials, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.4, item };
	} else if (item._type === "entity") {
		const materials = findRelevantMaterials(item.name, item.desc || "", allFiles, 8000);
		return { name: item.name, path: pagePath, prompt: buildEntityPrompt(item, materials, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.3, item };
	} else {
		let sourceContent = "";
		if (item.source_file) {
			const sourceFile = allFiles.find(f => f.path.includes(item.source_file));
			if (sourceFile) sourceContent = sourceFile.content.slice(0, 10000);
		}
		if (!sourceContent) sourceContent = findRelevantMaterials(item.name, item.desc || "", allFiles, 8000);
		return { name: item.name, path: pagePath, prompt: buildSourcePrompt(item, sourceContent, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.3, item };
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
		const fieldsMatch = item._type === oldItem._type &&
			(item.title || item.name) === (oldItem.title || oldItem.name) &&
			(item.level || "") === (oldItem.level || "") &&
			(item.desc || "") === (oldItem.desc || "");
		if (!fieldsMatch) { regen.push(item); continue; }
		const isAffected = changedContent.includes(item.name) || changedContent.includes(item.title || "") || changedPaths.includes(item.source_file || "");
		isAffected ? regen.push(item) : skip.push(item);
	}

	for (const [name, item] of oldMap) {
		if (!matchedOld.has(name)) remove.push(item);
	}

	return { regen, skip, remove };
}

// 主编译流程
export async function runCompile(
	app: App,
	settings: PluginSettings,
	onProgress: (e: ProgressEvent) => void = () => {},
	forceRecompile = false,
	plugin?: { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> }
) {
	const { rawFolder, wikiFolder } = settings;

	// Load template config
	const tpl = await loadTemplateConfig(app, settings.templateFile, settings.language);

	// Step 1: 读取素材
	onProgress({ step: 1, stepName: "读取素材", detail: "正在扫描...", percent: 15 });
	const allFiles = await readRawFiles(app, rawFolder);
	if (allFiles.length === 0) throw new Error(`${rawFolder}/ 目录为空`);

	// 加载缓存
	let cache: CompileCache = (await (plugin || app).loadData()) as CompileCache || emptyCache();
	if (!cache.fingerprints) cache = emptyCache();

	const { changed: changedFiles } = diffFingerprints(allFiles, cache);
	const hasChanges = changedFiles.length > 0;

	onProgress({ step: 1, stepName: "读取素材", detail: `${allFiles.length} 个文件，${hasChanges ? changedFiles.length + " 个有变化" : "全部未变化"}`, percent: 25 });

	if (!hasChanges && !forceRecompile && cache.analysis) {
		onProgress({ step: 2, stepName: "检查", detail: "素材无变化，跳过编译", percent: 100 });
		return { conceptsCount: cache.analysis.concepts?.length || 0, entitiesCount: cache.analysis.entities?.length || 0, sourcesCount: cache.analysis.sources?.length || 0, changed: 0, skippedByDiff: totalAnalysisCount(cache.analysis), generated: 0, errors: [], reused: true };
	}

	// Step 2: AI 分析
	let newAnalysis: Analysis;
	const oldAnalysis = forceRecompile ? null : cache.analysis;

	const canIncremental = !forceRecompile && Object.keys(cache.perFileAnalysis || {}).length > 0 && changedFiles.length > 0 && changedFiles.length < allFiles.length;

	if (canIncremental) {
		onProgress({ step: 2, stepName: "AI 增量分析", detail: `分析 ${changedFiles.length} 个变化文件...`, percent: 30 });
		const existingNames = [...(cache.analysis?.concepts || []).map(c => c.name), ...(cache.analysis?.entities || []).map(e => e.name)];
		const changedMaterials = changedFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, 3000)}`).join("\n\n");
		if (!changedMaterials) {
			newAnalysis = cache.analysis!;
		} else {
			const result = await callLLM([{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildIncrementalAnalyzePrompt(changedMaterials.slice(0, MAX_CHARS), existingNames, tpl) }], settings, { maxTokens: ANALYSIS_MAX_TOKENS });
				const incrementalResult = parseAnalysisJSON(result);
				if (incrementalResult.concepts.length === 0 && incrementalResult.entities.length === 0 && incrementalResult.sources.length === 0) {
					new Notice(t("notice.badAnalysis", settings.language));
					newAnalysis = cache.analysis!;
				} else {
					newAnalysis = mergeAnalysis(cache.analysis!, incrementalResult);
				}
		}
	} else {
		onProgress({ step: 2, stepName: "AI 分析素材", detail: "正在提取概念...", percent: 30 });
		const analysisMaterials = allFiles.filter(f => !f.path.includes("_usage")).map(f => `--- 文件: ${f.path} ---\n${f.content.slice(0, 2000)}`).join("\n\n");
		const result = await callLLM([{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: buildAnalyzePrompt(analysisMaterials.slice(0, MAX_CHARS), tpl) }], settings, { maxTokens: ANALYSIS_MAX_TOKENS });
			newAnalysis = parseAnalysisJSON(result);
			if (newAnalysis.concepts.length === 0 && newAnalysis.entities.length === 0 && newAnalysis.sources.length === 0) {
				throw new Error("AI 分析返回格式异常，请重试");
			}
	}

	cache.analysis = newAnalysis;
	cache.analysisTime = new Date().toISOString();
	const cc = newAnalysis.concepts?.length || 0;
	const ce = newAnalysis.entities?.length || 0;
	const cs = newAnalysis.sources?.length || 0;
	onProgress({ step: 2, stepName: "AI 分析", detail: `提取：${cc} 概念 + ${ce} 实体 + ${cs} 来源`, percent: 40 });

	// Step 3: Diff + 生成
	const { regen, skip, remove } = diffAnalysis(oldAnalysis, newAnalysis, changedFiles);
	const totalPages = cc + ce + cs;
	onProgress({ step: 3, stepName: "增量分析", detail: `新增/变化 ${regen.length}，跳过 ${skip.length}，删除 ${remove.length}`, percent: 45 });

	for (const item of remove) {
		const pagePath = getPagePath(item);
		if (cache.pages[pagePath]) {
			await deleteWikiFile(app, wikiFolder, pagePath);
			delete cache.pages[pagePath];
		}
	}

	const concepts = newAnalysis.concepts || [];
	const tasks = regen.map(item => buildTask(item, allFiles, concepts));
	let pagesDone = skip.length;
	const errors: Array<{ name: string; path: string; error: string }> = [];

	for (let i = 0; i < tasks.length; i += BATCH) {
		const batch = tasks.slice(i, i + BATCH);
		onProgress({ step: 3, stepName: "生成 wiki", detail: `生成中 (${batch.length} 个)...`, percent: 45 + Math.floor((i / Math.max(tasks.length, 1)) * 45), pagesDone, pagesTotal: totalPages });

		const results = await Promise.allSettled(batch.map(async (task) => {
			const raw = await callLLM([{ role: "system", content: task.system }, { role: "user", content: task.prompt }], settings, { temperature: task.temp });
			const page = ensureDraftStatus(raw);
			await writeWikiFile(app, wikiFolder, task.path, page);
			cache.pages[task.path] = { key: task.item.name, generatedAt: new Date().toISOString() };
			pagesDone++;
		}));

		for (let j = 0; j < results.length; j++) {
			if (results[j].status === "rejected") {
				errors.push({ name: batch[j].name, path: batch[j].path, error: (results[j] as PromiseRejectedResult).reason?.message || "未知错误" });
				pagesDone++;
			}
		}

		await (plugin || app).saveData(cache);
		}

		// Step 3.5: 生成 synthesis 页面（跨概念综合分析）
		const syntheses = newAnalysis.syntheses || [];
		if (syntheses.length > 0) {
			onProgress({ step: 3, stepName: "生成综合分析", detail: `${syntheses.length} 个跨概念分析...`, percent: 90 });
			const wikiFiles = await readWikiFiles(app, wikiFolder);
			const conceptPages = wikiFiles
				.filter(f => f.path.includes("concepts/"))
				.map(f => ({ name: f.path.split("/").pop()!.replace(".md", ""), content: f.content }));

			for (const synth of syntheses) {
				try {
					const synthPrompt = buildSynthesisPrompt(synth, concepts, conceptPages, tpl);
					const rawPage = await callLLM(
						[{ role: "system", content: tpl.synthesisEditorPrompt }, { role: "user", content: synthPrompt }],
						settings, { temperature: 0.5 }
					);
					const page = ensureDraftStatus(rawPage);
					await writeWikiFile(app, wikiFolder, `syntheses/${synth.name}.md`, page);
				} catch (e: any) {
					errors.push({ name: synth.name, path: `syntheses/${synth.name}.md`, error: e.message });
				}
			}
			await (plugin || app).saveData(cache);
		}


		// Step 4: 生成索引
		onProgress({ step: 4, stepName: "生成索引", detail: "更新 index.md...", percent: 95 });
	const TODAY = new Date().toISOString().split("T")[0];

	// 构建索引
	cache.indexEntries = cache.indexEntries || {};
	for (const c of concepts) {
		cache.indexEntries[getPagePath({ ...c, _type: "concept" })] = { type: "concept", level: c.level || "", name: c.name, title: c.title || c.name, desc: c.desc || c.title || "" };
	}
	for (const e of (newAnalysis.entities || [])) {
		cache.indexEntries[getPagePath({ ...e, _type: "entity" })] = { type: "entity", level: "", name: e.name, title: e.name, desc: e.desc || "" };
	}
	for (const s of (newAnalysis.sources || [])) {
		cache.indexEntries[getPagePath({ ...s, _type: "source" })] = { type: "source", level: "", name: s.name, title: s.desc || s.name, desc: s.desc || "" };
	}
		for (const syn of (newAnalysis.syntheses || [])) {
			cache.indexEntries[`syntheses/${syn.name}.md`] = { type: "synthesis", level: "", name: syn.name, title: syn.question || syn.name, desc: syn.question || "" };
		}

	// 从 indexEntries 构建 index.md
	const levels: Record<string, Array<{ name: string; title: string; desc: string }>> = {};
	const entities: Array<{ name: string; desc: string }> = [];
	const sources: Array<{ name: string; desc: string }> = [];
		const synthEntries: Array<{ name: string; desc: string }> = [];

	for (const entry of Object.values(cache.indexEntries)) {
		if (entry.type === "concept") {
			const level = entry.level || "方法框架";
			if (!levels[level]) levels[level] = [];
			levels[level].push({ name: entry.name, title: entry.title, desc: entry.desc });
		} else if (entry.type === "entity") {
			entities.push({ name: entry.name, desc: entry.desc });
		} else if (entry.type === "source") {
			sources.push({ name: entry.name, desc: entry.desc });
			} else if (entry.type === "synthesis") {
				syntheses.push({ name: entry.name, desc: entry.desc });
		}
	}

	let indexContent = `---\ntitle: "Wiki Index"\ntype: index\nlast_updated: ${TODAY}\n---\n\n# Wiki Index\n\n## 概念体系\n\n`;
	for (const [level, items] of Object.entries(levels)) {
		if (items.length === 0) continue;
		indexContent += `### ${level} — ${(tpl.levels.find(l => l.key === level)?.desc || level)}\n\n`;
		for (const item of items) indexContent += `- [[${item.name}|${item.title}]] — ${item.desc}\n`;
		indexContent += "\n";
	}
	if (entities.length) {
		indexContent += "### Entities\n\n";
		for (const e of entities) indexContent += `- [[${e.name}]] — ${e.desc}\n`;
		indexContent += "\n";
	}
	if (sources.length) {
		indexContent += "### Sources\n\n";
		for (const s of sources) indexContent += `- [[${s.name}]] — ${s.desc}\n`;
		indexContent += "\n";
	}

	await writeWikiFile(app, wikiFolder, "index.md", indexContent);

	// 更新指纹 + 保存
	updateFingerprints(allFiles, cache);
	await (plugin || app).saveData(cache);

	onProgress({ step: 4, stepName: "完成", detail: "编译完成", percent: 100 });

	return { conceptsCount: cc, entitiesCount: ce, sourcesCount: cs, changed: changedFiles.length, skippedByDiff: skip.length, generated: regen.length - errors.length, removed: remove.length, errors, reused: false };
}

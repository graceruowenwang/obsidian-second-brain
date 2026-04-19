// 编译页面生成 -- 任务构建 + 页面渲染 + Diff 分析
// JSON 解析/校验/后处理 → compile-analysis.ts
// 素材检索 → compile-materials.ts

import { App, TFile } from "obsidian";
import { callLLM, callLLMBatch, type BatchTask } from "./llm";
import { readWikiFiles, writeWikiFile, deleteWikiFile, getStorage } from "./file-utils";
import type { StorageLike } from "./file-utils";
import {
	buildConceptPrompt, buildEntityPrompt, buildSourcePrompt, buildSynthesisPrompt,
} from "./wiki-schema";
import type { TemplateConfig } from "./templates";
import type { Analysis, CompileCache, ProgressEvent, Concept, Entity, Source, PluginSettings } from "../types";
import {
	postProcessPage,
	getPagePath, checkAborted, findAffectedPages,
} from "./compile-analysis";
import type { AnalysisItem } from "./compile-analysis";
import {
	findRelevantMaterials,
} from "./compile-materials";

const BATCH = 5;

export interface Task {
	name: string;
	path: string;
	prompt: string;
	system: string;
	temp: number;
	item: AnalysisItem;
}

export async function buildTask(item: AnalysisItem, allFiles: Array<{ path: string; content: string }>, concepts: Concept[], tpl: TemplateConfig, settings: PluginSettings): Promise<Task> {
	const pagePath = getPagePath(item);
	const desc = item.desc || "";
	if (item._type === "concept") {
		const c = item as Concept;
		const materials = await findRelevantMaterials(c.name, desc || c.title, allFiles, settings, 10000);
		return { name: c.title || c.name, path: pagePath, prompt: buildConceptPrompt(c, materials, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.4, item };
	} else if (item._type === "entity") {
		const e = item as Entity;
		const materials = await findRelevantMaterials(e.name, desc, allFiles, settings, 8000);
		return { name: e.name, path: pagePath, prompt: buildEntityPrompt(e, materials, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.3, item };
	} else {
		const s = item as Source;
		let sourceContent = "";
		if (s.source_file) {
			const sourceFile = allFiles.find(f => f.path === s.source_file || f.path.endsWith("/" + s.source_file));
			if (sourceFile) sourceContent = sourceFile.content.slice(0, 10000);
		}
		if (!sourceContent) sourceContent = await findRelevantMaterials(s.name, desc, allFiles, settings, 8000);
		return { name: s.name, path: pagePath, prompt: buildSourcePrompt(s, sourceContent, concepts, tpl), system: tpl.editorSystemPrompt, temp: 0.3, item };
	}
}

export function diffAnalysis(oldAnalysis: Analysis | null, newAnalysis: Analysis, changedFiles: Array<{ path: string; content: string }>, dependencies?: Record<string, string[]>): { regen: AnalysisItem[]; skip: AnalysisItem[]; remove: AnalysisItem[] } {
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

	const changedPathsSet = new Set(changedFiles.map(f => f.path));

	// 使用依赖图做受影响页面传递闭包
	let affectedPages = new Set<string>();
	if (dependencies && Object.keys(dependencies).length > 0) {
		affectedPages = findAffectedPages(changedPathsSet, dependencies);
	}

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

		// 使用依赖图判断是否受影响（优先），降级到旧逻辑
		const pagePath = getPagePath(item);
		const isAffected = affectedPages.has(pagePath)
			|| (affectedPages.size === 0 && (
				changedPathsSet.has(item.source_file || "")
				|| changedFiles.some(f => f.content.includes(item.name) || f.content.includes(itemTitle))
			));
		isAffected ? regen.push(item) : skip.push(item);
	}

	for (const [name, item] of oldMap) {
		if (!matchedOld.has(name)) remove.push(item);
	}

	return { regen, skip, remove };
}

export interface PageGenResult {
	errors: Array<{ name: string; path: string; error: string }>;
	generated: number;
	skippedByDiff: number;
	removed: number;
	protectedByReview: number;
	conflictCheckNeeded: Array<{ item: AnalysisItem; oldContent: string }>;
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
	plugin?: StorageLike,
	signal?: AbortSignal,
): Promise<PageGenResult> {
	checkAborted(signal);

	const concepts = newAnalysis.concepts || [];
	const totalPages = concepts.length + (newAnalysis.entities?.length || 0) + (newAnalysis.sources?.length || 0);

	const validPageNames = new Set<string>();
	for (const c of concepts) validPageNames.add(c.name);
	for (const e of (newAnalysis.entities || [])) validPageNames.add(e.name);
	for (const s of (newAnalysis.sources || [])) validPageNames.add(s.name);

	const { regen, skip, remove } = diffAnalysis(oldAnalysis, newAnalysis, changedFiles, cache.dependencies);
	onProgress({ step: 3, stepName: "增量分析", detail: `新增/变化 ${regen.length}，跳过 ${skip.length}，删除 ${remove.length}`, percent: 45 });

	const changedPathsSet = new Set(changedFiles.map(f => f.path));
	for (const item of skip) {
		if (item.source_file && changedPathsSet.has(item.source_file)) {
			const pagePath = getPagePath(item);
			const existingFile = app.vault.getAbstractFileByPath(`${wikiFolder}/${pagePath}`);
			if (existingFile instanceof TFile) {
				try {
					const existingContent = await app.vault.cachedRead(existingFile);
					if (!/^status:\s*["']?reviewed["']?/m.test(existingContent)) {
						const updated = existingContent.replace(/^status:\s*["']?\w+["']?\s*$/m, 'status: "outdated"');
						await app.vault.modify(existingFile, updated);
					}
				} catch (e) {
					console.warn("compile-pages: mark outdated failed:", e);
				}
			}
		}
	}

	for (const item of remove) {
		const pagePath = getPagePath(item);
		if (cache.pages[pagePath]) {
			await deleteWikiFile(app, wikiFolder, pagePath);
			delete cache.pages[pagePath];
		}
		delete cache.indexEntries[pagePath];
		delete cache.failedPages[pagePath];
	}

	const changedPaths = new Set(changedFiles.map(f => f.path));
	const finalRegen: AnalysisItem[] = [];
	const syncProtected: AnalysisItem[] = [];
	const conflictCheckNeeded: Array<{ item: AnalysisItem; oldContent: string }> = [];
	for (const item of regen) {
		const pagePath = getPagePath(item);
		const existingFile = app.vault.getAbstractFileByPath(`${wikiFolder}/${pagePath}`);
		if (existingFile instanceof TFile) {
			try {
				const existingContent = await app.vault.cachedRead(existingFile);
				const head = existingContent.slice(0, 500);
				if (/^type:\s*["']?moc["']?/m.test(head)) {
					syncProtected.push(item);
					continue;
				}
				if (/status:\s*["']?reviewed["']?/m.test(head)) {
					if (item.source_file && !changedPaths.has(item.source_file)) {
						syncProtected.push(item);
						continue;
					}
					conflictCheckNeeded.push({ item, oldContent: existingContent });
					finalRegen.push(item);
					continue;
				}
			} catch (e) {
				console.warn("compile-pages: read existing failed:", e);
			}
		}
		finalRegen.push(item);
	}

	if (cache.failedPages) {
		for (const [path, entry] of Object.entries(cache.failedPages)) {
			if (entry.failCount < 3) {
				const existing = finalRegen.find(r => getPagePath(r as AnalysisItem) === path);
				if (!existing) {
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

	const tasks = await Promise.all(finalRegen.map(item => buildTask(item, allFiles, concepts, tpl, settings)));
	let pagesDone = skip.length + syncProtected.length;
	const errors: Array<{ name: string; path: string; error: string }> = [];

	if (!cache.failedPages) cache.failedPages = {};

	// 使用 callLLMBatch 替代手写循环，带独立重试和批次间延迟
	if (tasks.length > 0) {
		checkAborted(signal);
		onProgress({ step: 3, stepName: "生成 wiki", detail: `生成中 (${tasks.length} 个)...`, percent: 50, pagesDone, pagesTotal: totalPages });

		const batchTasks: BatchTask[] = tasks.map(task => ({
			messages: [{ role: "system", content: task.system }, { role: "user", content: task.prompt }],
			options: { temperature: task.temp, signal },
		}));

		const batchResults = await callLLMBatch(batchTasks, settings, { concurrency: 5, batchDelay: 500, perItemRetry: 3, signal });

		for (let j = 0; j < batchResults.length; j++) {
			const result = batchResults[j];
			const task = tasks[j];
			if (result.status === "fulfilled" && result.value) {
				const page = postProcessPage(result.value, task.item._type, task.item, tpl, validPageNames);
				await writeWikiFile(app, wikiFolder, task.path, page);
				cache.pages[task.path] = { key: task.item.name, generatedAt: new Date().toISOString() };
				delete cache.failedPages[task.path];
			} else {
				const errMsg = result.reason || "未知错误";
				errors.push({ name: task.name, path: task.path, error: errMsg });
				cache.failedPages[task.path] = {
					name: task.name,
					path: task.path,
					error: errMsg,
					failCount: (cache.failedPages[task.path]?.failCount || 0) + 1,
					lastFailedAt: new Date().toISOString(),
				};
			}
			pagesDone++;
		}
		await getStorage(app, plugin).saveData(cache);
	}


	// Synthesis 页面生成
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
		conflictCheckNeeded,
	};
}

// 异步冲突检测（post-compile，不阻塞主流程）
	export async function runConflictDetection(
		conflictCheckNeeded: Array<{ item: AnalysisItem; oldContent: string }>,
		wikiFolder: string,
		app: App,
		settings: PluginSettings,
		tpl: TemplateConfig,
		signal?: AbortSignal,
	): Promise<number> {
		if (conflictCheckNeeded.length === 0) return 0;
		let conflictsFound = 0;
		const tplConflictHeader = tpl.conflictHeader;

		for (const { item, oldContent } of conflictCheckNeeded) {
			if (signal?.aborted) break;
			const pagePath = getPagePath(item);
			const newFile = app.vault.getAbstractFileByPath(`${wikiFolder}/${pagePath}`);
			if (!(newFile instanceof TFile)) continue;

			try {
				const newContent = await app.vault.cachedRead(newFile);
				const oldStripped = oldContent.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
				const newStripped = newContent.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

				const conflictResult = await callLLM([
					{ role: "system", content: "Knowledge management expert. Detect factual contradictions between old and new wiki page versions." },
					{ role: "user", content: `Compare old vs new page "${item.name}".

OLD:
${'$'}{oldStripped.slice(0, 3000)}

NEW:
${'$'}{newStripped.slice(0, 3000)}

Contradictions? JSON only: {"has_conflict":bool,"description":"...","old_view":"...","new_view":"..."}` },
				], settings, { maxTokens: 500, temperature: 0.1, signal });

				const jsonMatch = conflictResult.match(/\{[\s\S]*\}/);
				if (jsonMatch) {
					const parsed = JSON.parse(jsonMatch[0]);
					if (parsed.has_conflict) {
						conflictsFound++;
						const section = `\n\n## ${'$'}{tplConflictHeader}\n> ${'$'}{parsed.description || ""}\n> **Old**: ${'$'}{parsed.old_view || ""}\n> **New**: ${'$'}{parsed.new_view || ""}`;
						const updated = newContent.replace(/\n*$/, "") + section + "\n";
						const withStatus = updated.replace(/^status:\s*["']?\w+["']?\s*$/m, 'status: "conflict"');
						await app.vault.modify(newFile, withStatus);
					}
				}
			} catch (e) {
				console.warn("compile-pages: conflict check failed:", e);
			}
		}
		return conflictsFound;
	}

// Re-export for backward compatibility
export { parseAnalysisJSON, validateAnalysis, ensureDraftStatus, postProcessPage, mergeAnalysis, getPagePath, checkAborted } from "./compile-analysis";
export type { AnalysisItem } from "./compile-analysis";
export { findRelevantMaterials } from "./compile-materials";

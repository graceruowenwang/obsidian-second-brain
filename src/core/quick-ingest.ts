// 单文件快速编译 — 从 main.ts 抽离

import { App } from "obsidian";
import { readWikiFiles, writeWikiFile, filesToMap } from "./file-utils";
import { callLLM } from "./llm";
import { buildIncrementalAnalyzePrompt, buildConceptPrompt, buildEntityPrompt, buildSourcePrompt } from "./wiki-schema";
import { loadTemplateConfig } from "./templates";
import { parseAnalysisJSON, ensureDraftStatus } from "./compile-pages";
import type { PluginSettings, Concept, Entity, Source } from "../types";

export interface QuickIngestResult {
	generated: string[];
	errors: Array<{ name: string; error: string }>;
}

export async function quickIngest(
	app: App,
	settings: PluginSettings,
	targetFile: { path: string; content: string },
): Promise<QuickIngestResult> {
	const wikiFiles = await readWikiFiles(app, settings.wikiFolder);
	const existingNames = Object.keys(filesToMap(wikiFiles)).map(p => p.split("/").pop()!.replace(/\.md$/, ""));

	const tpl = await loadTemplateConfig(app, settings.templateFile, settings.language);

	const changedMaterials = `--- 文件: ${targetFile.path} ---\n${targetFile.content.slice(0, 4000)}`;
	const prompt = buildIncrementalAnalyzePrompt(changedMaterials, existingNames, tpl);

	const analysisResult = await callLLM(
		[{ role: "system", content: tpl.analysisSystemPrompt }, { role: "user", content: prompt }],
		settings,
		{ maxTokens: 4000 },
	);

	const analysis = parseAnalysisJSON(analysisResult);
	const concepts = analysis.concepts || [];
	const generated: string[] = [];
	const errors: Array<{ name: string; error: string }> = [];

	const tasks: Array<{ name: string; path: string; type: "concept" | "entity" | "source"; item: Concept | Entity | Source; materials: string }> = [];

	for (const c of concepts) {
		const levelDir = c.level === "核心概念" ? "核心概念" : c.level === "实践经验" ? "实践经验" : "方法框架";
		const pagePath = `concepts/${levelDir}/${c.name}.md`;
		tasks.push({ name: c.title || c.name, path: pagePath, type: "concept", item: c, materials: targetFile.content.slice(0, 10000) });
	}
	for (const e of (analysis.entities || [])) {
		tasks.push({ name: e.name, path: `entities/${e.name}.md`, type: "entity", item: e, materials: targetFile.content.slice(0, 8000) });
	}
	for (const s of (analysis.sources || [])) {
		tasks.push({ name: s.name, path: `sources/${s.name}.md`, type: "source", item: s, materials: targetFile.content.slice(0, 10000) });
	}

	for (const task of tasks) {
		let genPrompt: string;
		if (task.type === "concept") genPrompt = buildConceptPrompt(task.item as Concept, task.materials, concepts, tpl);
		else if (task.type === "entity") genPrompt = buildEntityPrompt(task.item as Entity, task.materials, concepts, tpl);
		else genPrompt = buildSourcePrompt(task.item as Source, task.materials, concepts, tpl);

		try {
			const raw = await callLLM(
				[{ role: "system", content: tpl.editorSystemPrompt }, { role: "user", content: genPrompt }],
				settings,
				{ temperature: 0.3 },
			);
			const page = ensureDraftStatus(raw);
			await writeWikiFile(app, settings.wikiFolder, task.path, page);
			generated.push(task.path);
		} catch (e: unknown) {
			errors.push({ name: task.name, error: e instanceof Error ? e.message : String(e) });
		}
	}

	return { generated, errors };
}

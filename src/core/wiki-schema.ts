// Wiki 规则数据 -- prompt 模板，支持多语言和用户自定义

import type { Concept, Entity, Source, Synthesis } from "../types";
import type { TemplateConfig } from "./templates";

function isOriginalInsightMaterial(sourceFile: string): boolean {
	if (!sourceFile) return false;
	// 兼容旧路径与新中文路径（含曾用序号 09 的闪念目录）。
	return sourceFile.includes("06-flash_notes")
		|| sourceFile.includes("08-闪念速记")
		|| sourceFile.includes("09-闪念速记");
}

export function today(): string {
	return new Date().toISOString().split("T")[0];
}

// Frontmatter 模板
function yamlStr(v: string): string {
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function frontmatter(fields: Record<string, any>): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(fields)) {
		if (Array.isArray(v)) {
			if (v.length > 0) {
				lines.push(`${k}:`);
				for (const item of v) lines.push(`  - ${yamlStr(String(item))}`);
			}
		} else {
			lines.push(`${k}: ${yamlStr(String(v))}`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

export function conceptFrontmatter(concept: Concept): string {
	const originalFiles: string[] = [];
	const referenceFiles: string[] = [];
	if (concept.source_file) {
		if (isOriginalInsightMaterial(concept.source_file)) {
			originalFiles.push(concept.source_file);
		} else {
			referenceFiles.push(concept.source_file);
		}
	}
	return frontmatter({
		title: concept.title,
		type: "concept",
		level: concept.level,
		tags: [concept.title],
		...(originalFiles.length > 0 ? { original: originalFiles } : {}),
		...(referenceFiles.length > 0 ? { reference: referenceFiles } : {}),
		last_updated: today(),
	});
}

export function entityFrontmatter(entity: Entity): string {
	return frontmatter({
		title: entity.name,
		type: "entity",
		tags: [],
		last_updated: today(),
	});
}

export function sourceFrontmatter(source: Source): string {
	const referenceFiles: string[] = [];
	if (source.source_file) referenceFiles.push(source.source_file);
	return frontmatter({
		title: source.desc,
		type: "source",
		...(referenceFiles.length > 0 ? { reference: referenceFiles } : {}),
		last_updated: today(),
	});
}

// 构建 PAGE_RULES 段（从模板配置动态生成）
function buildPageRules(tpl: TemplateConfig): string {
	const levelKeys = tpl.levels.map(l => l.key).join(" | ");
	return `Rules:
${tpl.pageRules}
- First line must be YAML frontmatter (wrapped in ---):
  ---
  title: "Page Title"
  type: concept | entity | source
  level: ${levelKeys}
  status: "draft"
  tags: [tags]
  last_updated: ${today()}
  ---
  type and level depend on page type; concept pages must have level field
  status is always "draft", meaning AI-generated pending review
- End with ## ${tpl.relatedLinksHeader}, listing all referenced concepts/entities/sources as - [[PageName|Display]]
- Must link to at least 2 other existing pages to avoid orphan pages`.trim();
}

// 分析 prompt 的 JSON 输出格式（含 levels 动态生成）
function analysisOutputFormat(tpl: TemplateConfig): string {
	const levelKeys = tpl.levels.map(l => l.key).join("|");
	return `{"concepts":[{"name":"ConceptName","title":"DisplayTitle","level":"${levelKeys}","desc":"One-line description","source_file":"source_file_path"}],"entities":[{"name":"EntityName","desc":"One-line description"}],"sources":[{"name":"source-slug","source_file":"filename","desc":"One-line summary"}],"syntheses":[{"name":"synthesis-slug","question":"How do these concepts relate?","concepts":["ConceptA","ConceptB"]}]}`;
}

export function buildAnalyzePrompt(materials: string, tpl: TemplateConfig): string {
	const levelsDesc = tpl.levels.map(l => `${l.key}（${l.desc}）`).join("、");
	return `${tpl.analysisSystemPrompt} Please analyze the following materials and extract core concepts.

Rules:
1. Name each concept in TitleCase (English)
2. Give each concept a one-line description
3. Classify into levels: ${levelsDesc}
4. Also identify: entities (people/organizations), sources (material summaries)
5. Prefer broader concept granularity; merge similar concepts
6. Output pure JSON only, no markdown code blocks

Output format:
${analysisOutputFormat(tpl)}

Materials:
${materials}`;
}

export function buildIncrementalAnalyzePrompt(changedMaterials: string, existingNames: string[], tpl: TemplateConfig): string {
	const levelsDesc = tpl.levels.map(l => `${l.key}（${l.desc}）`).join("、");
	const existingList = existingNames.length > 0
		? `\nExisting concept names (keep consistent, do not duplicate): ${existingNames.join(", ")}\n`
		: "";
	return `${tpl.analysisSystemPrompt} Here are new/changed materials. Please extract core concepts from them.

Rules:
1. Name each concept in TitleCase (English), consistent with existing concepts
2. Give each concept a one-line description
3. Classify into levels: ${levelsDesc}
4. Also identify: entities (people/organizations), sources (material summaries)
5. Only extract concepts from these new materials, do not duplicate existing ones
6. Prefer broader concept granularity; merge similar concepts
7. Output pure JSON only, no markdown code blocks
${existingList}
Output format:
${analysisOutputFormat(tpl)}

New/changed materials:
${changedMaterials}`;
}

function getMaterialTypeHint(sourceFile: string, tpl: TemplateConfig): string {
	if (!sourceFile) return "";
	if (isOriginalInsightMaterial(sourceFile)) {
		return `\nIMPORTANT: These materials are from the user's own notes (flash_notes). You MUST mark any original user insights, personal opinions, or unique observations with > ${tpl.originalPrefix} as a blockquote prefix. This is the user's own thinking - distinguish it clearly from reference material.`;
	}
	return "";
}

export function buildConceptPrompt(concept: Concept, materials: string, allConcepts: Concept[], tpl: TemplateConfig): string {
	const otherConcepts = allConcepts
		.filter((c) => c.name !== concept.name)
		.map((c) => `${c.name}(${c.title})`);
	const materialHint = getMaterialTypeHint(concept.source_file, tpl);
	return `Based on the following materials, write a complete wiki page for concept "${concept.name} (${concept.title})".

${buildPageRules(tpl)}
- First line is a one-sentence definition of the concept
- Then expand on the core content in 2-4 subsections, each with viewpoints and arguments
- If the materials contain original user insights, mark those paragraphs with > ${tpl.originalPrefix}
${materialHint}

Existing concepts (must link to related ones using [[Name|Display]] in the text): ${otherConcepts.slice(0, 20).join(", ")}
- You must link to at least 3 existing concepts to reduce orphan pages

Materials:
${materials}`;
}

export function buildEntityPrompt(entity: Entity, materials: string, allConcepts: Concept[], tpl: TemplateConfig): string {
	const conceptList = (allConcepts || []).map((c) => `${c.name}(${c.title})`).slice(0, 15).join(", ");
	const linkHint = conceptList ? `\nExisting concepts (link related ones with [[Name|Display]]): ` + conceptList : "";
	return `Based on the following materials, write a brief wiki page for entity "${entity.name}".

${buildPageRules(tpl)}
- Introduce the identity and core contributions of this person/organization${linkHint}

Materials:
${materials}`;
}

export function buildSourcePrompt(source: Source, materials: string, allConcepts: Concept[], tpl: TemplateConfig): string {
	const conceptList = (allConcepts || []).map((c) => `${c.name}(${c.title})`).slice(0, 15).join(", ");
	const linkHint = conceptList ? `\nExisting concepts (link related ones with [[Name|Display]]): ` + conceptList : "";
	const materialHint = getMaterialTypeHint(source.source_file, tpl);
	return `Write a summary wiki page for the following material.

Source file: ${source.source_file}
Summary topic: ${source.desc}

${buildPageRules(tpl)}
- Extract 3-5 key points, do not copy the original text${linkHint}
${materialHint}

Materials:
${materials}`;
}

export function buildSynthesisPrompt(synthesis: Synthesis, allConcepts: Concept[], conceptPages: Array<{ name: string; content: string }>, tpl: TemplateConfig): string {
	const conceptList = allConcepts.map((c) => `${c.name}(${c.title})`).slice(0, 20).join(", ");
	const relatedConcepts = allConcepts.filter(c => synthesis.concepts.includes(c.name));
	const relatedContent = conceptPages
		.filter(p => synthesis.concepts.some(cn => p.name === cn))
		.map(p => `=== ${p.name} ===\n${p.content.slice(0, 1500)}`)
		.join("\n\n");

	return `${tpl.synthesisEditorPrompt} Based on the following wiki pages of multiple concepts, write a cross-concept synthesis page.

Core question this page should answer: ${synthesis.question}
Related concepts: ${relatedConcepts.map(c => `${c.name}(${c.title})`).join(", ")}

${buildPageRules(tpl)}
- type is always synthesis
- No level field needed
- First paragraph answers the core question in one passage
- Then 2-3 subsections analyzing from cross-concept perspectives
- Identify deep connections, contradictions, or complementary relationships between these concepts
- Provide insights or recommendations based on the analysis

Existing concepts (must link to related ones using [[Name|Display]] in the text): ${conceptList}

Related concept wiki content:
${relatedContent.slice(0, 12000)}`;
}

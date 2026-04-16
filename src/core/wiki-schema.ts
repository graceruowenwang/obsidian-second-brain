// Wiki 规则数据 — 知识库编译的 prompt 模板
// 从 wiki-schema.js 移植，逻辑不变

import type { Concept, Entity, Source } from "../types";

export const TODAY = new Date().toISOString().split("T")[0];

export const LEVELS: Record<string, string> = {
	核心概念: "你的领域中最基础的观点和立场",
	方法框架: "用来分析和解决问题的结构化工具",
	实践经验: "来自真实场景的案例、复盘和反思",
};

// Frontmatter 模板
export function frontmatter(fields: Record<string, any>): string {
	const lines = ["---"];
	for (const [k, v] of Object.entries(fields)) {
		if (Array.isArray(v)) {
			if (v.length > 0) {
				lines.push(`${k}:`);
				for (const item of v) lines.push(`  - "${item}"`);
			}
		} else {
			lines.push(`${k}: "${v}"`);
		}
	}
	lines.push("---");
	return lines.join("\n");
}

export function conceptFrontmatter(concept: Concept): string {
	const originalFiles: string[] = [];
	const referenceFiles: string[] = [];
	if (concept.source_file) {
		if (concept.source_file.includes("06-flash_notes")) {
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
		last_updated: TODAY,
	});
}

export function entityFrontmatter(entity: Entity): string {
	return frontmatter({
		title: entity.name,
		type: "entity",
		tags: [],
		last_updated: TODAY,
	});
}

export function sourceFrontmatter(source: Source): string {
	const referenceFiles: string[] = [];
	if (source.source_file) referenceFiles.push(source.source_file);
	return frontmatter({
		title: source.desc,
		type: "source",
		...(referenceFiles.length > 0 ? { reference: referenceFiles } : {}),
		last_updated: TODAY,
	});
}

export const PAGE_RULES = `
规则：
- 使用简体中文
- 第一行必须是 YAML frontmatter（--- 包裹），格式如下：
  ---
  title: "页面标题"
  type: concept | entity | source
  level: 核心概念 | 方法框架 | 实践经验
  tags: [标签]
  last_updated: ${TODAY}
  ---
  其中 type 和 level 根据页面类型填写，concept 页面必须有 level 字段
- 相关概念第一次出现时用 [[ConceptName|中文名]] 格式标记双向链接
- 结尾必须有 ## 关联连接，列出所有引用的概念/实体/来源，格式为 - [[PageName|显示名]]
- 不要产生孤岛页面，确保每个页面至少链接到 2 个其他已有页面
- 在正文中主动寻找与已有概念相关的内容，用双链标注
- 不要输出任何 frontmatter 之外的解释性文字，直接输出完整页面内容`.trim();

export function buildAnalyzePrompt(materials: string): string {
	return `你是一个知识管理专家。请分析以下素材，提取出核心概念。

规则：
1. 每个概念用 TitleCase 命名（英文）
2. 每个概念给一句中文描述
3. 按三层分类：${Object.entries(LEVELS).map(([k, v]) => `${k}（${v}）`).join("、")}
4. 除了概念，还要识别：实体（人物/组织）、来源（素材摘要）
5. 概念粒度宜粗不宜细，相近的概念应合并为一个
6. 直接输出纯 JSON，不要用 markdown 代码块包裹

输出格式：
{"concepts":[{"name":"ConceptName","title":"中文名","level":"核心概念|方法框架|实践经验","desc":"一句话描述","source_file":"来源文件路径"}],"entities":[{"name":"EntityName","desc":"一句话描述"}],"sources":[{"name":"摘要-source-slug","source_file":"文件名","desc":"一句话摘要"}]}

素材内容：
${materials}`;
}

export function buildIncrementalAnalyzePrompt(changedMaterials: string, existingNames: string[]): string {
	const existingList = existingNames.length > 0
		? `\n已有概念名（保持命名一致，不要重复）：${existingNames.join(", ")}\n`
		: "";
	return `你是一个知识管理专家。以下是新增/变化的素材，请从中提取核心概念。

规则：
1. 每个概念用 TitleCase 命名（英文），与已有概念保持命名一致
2. 每个概念给一句中文描述
3. 按三层分类：${Object.entries(LEVELS).map(([k, v]) => `${k}（${v}）`).join("、")}
4. 除了概念，还要识别：实体（人物/组织）、来源（素材摘要）
5. 只提取这些新素材中的概念，不要重复已有概念
6. 概念粒度宜粗不宜细，相近的概念应合并
7. 直接输出纯 JSON，不要用 markdown 代码块包裹
${existingList}
输出格式：
{"concepts":[{"name":"ConceptName","title":"中文名","level":"核心概念|方法框架|实践经验","desc":"一句话描述","source_file":"来源文件路径"}],"entities":[{"name":"EntityName","desc":"一句话描述"}],"sources":[{"name":"摘要-source-slug","source_file":"文件名","desc":"一句话摘要"}]}

新增/变化的素材：
${changedMaterials}`;
}

export function buildConceptPrompt(concept: Concept, materials: string, allConcepts: Concept[]): string {
	const otherConcepts = allConcepts
		.filter((c) => c.name !== concept.name)
		.map((c) => `${c.name}(${c.title})`);
	return `基于以下素材，为概念「${concept.name}（${concept.title}）」写一个完整的 wiki 页面。

${PAGE_RULES}
- 第一行是概念的一句话定义
- 然后展开说明核心内容，分 2-4 个小节，每节有观点和论证
- 如果素材中有用户的原创思考，用 > [原创] 标注该段落

已有概念（在正文中相关处必须用 [[Name|中文]] 链接）：${otherConcepts.slice(0, 20).join(", ")}
- 你必须至少链接到 3 个以上已有概念，减少孤岛页面

素材：
${materials}`;
}

export function buildEntityPrompt(entity: Entity, materials: string, allConcepts: Concept[]): string {
	const conceptList = (allConcepts || []).map((c) => `${c.name}(${c.title})`).slice(0, 15).join(", ");
	const linkHint = conceptList ? "\n已有概念（相关处用 [[Name|中文]] 链接）：" + conceptList : "";
	return `基于以下素材，为实体「${entity.name}」写一个简短的 wiki 页面。

${PAGE_RULES}
- 介绍这个人/组织的身份和核心贡献${linkHint}

素材：
${materials}`;
}

export function buildSourcePrompt(source: Source, materials: string, allConcepts: Concept[]): string {
	const conceptList = (allConcepts || []).map((c) => `${c.name}(${c.title})`).slice(0, 15).join(", ");
	const linkHint = conceptList ? "\n已有概念（相关处用 [[Name|中文]] 链接）：" + conceptList : "";
	return `为以下素材写一个摘要 wiki 页面。

来源文件：${source.source_file}
摘要主题：${source.desc}

${PAGE_RULES}
- 提炼 3-5 个核心要点，不要照搬原文${linkHint}

素材：
${materials}`;
}

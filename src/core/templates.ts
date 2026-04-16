// 模板系统 -- 多语言支持 + 用户自定义 prompt 模板

import { App, TFile, Notice } from "obsidian";

// === 模板配置接口 ===

export interface LevelDef {
	key: string;        // 用于文件路径和分类标识，如 "Core"
	label: string;      // 显示名，如 "核心概念"
	desc: string;       // 层级描述
}

export interface TemplateConfig {
	language: string;
	languageInstruction: string;   // "使用简体中文" / "Write in English"
	levels: LevelDef[];
	relatedLinksHeader: string;    // "关联连接" / "Related Links"
	conflictHeader: string;        // "知识冲突" / "Knowledge Conflict"
	originalPrefix: string;        // "[原创]" / "[Original]"
	pageRules: string;             // 完整的页面规则 prompt 段
	analysisSystemPrompt: string;
	editorSystemPrompt: string;
	synthesisEditorPrompt: string;
}

// === 内置预设 ===

const ZH_PRESET: TemplateConfig = {
	language: "zh-CN",
	languageInstruction: "使用简体中文",
	levels: [
		{ key: "核心概念", label: "核心概念", desc: "你的领域中最基础的观点和立场" },
		{ key: "方法框架", label: "方法框架", desc: "用来分析和解决问题的结构化工具" },
		{ key: "实践经验", label: "实践经验", desc: "来自真实场景的案例、复盘和反思" },
	],
	relatedLinksHeader: "关联连接",
	conflictHeader: "知识冲突",
	originalPrefix: "[原创]",
	pageRules: `- 使用简体中文
- 第一行必须是 YAML frontmatter（--- 包裹）
- 相关概念第一次出现时用 [[ConceptName|中文名]] 格式标记双向链接
- 结尾必须有 ## 关联连接，列出所有引用的概念/实体/来源，格式为 - [[PageName|显示名]]
- 不要产生孤岛页面，确保每个页面至少链接到 2 个其他已有页面
- 在正文中主动寻找与已有概念相关的内容，用双链标注
- 不要输出任何 frontmatter 之外的解释性文字，直接输出完整页面内容`,
	analysisSystemPrompt: "你是知识管理专家。输出严格的 JSON。",
	editorSystemPrompt: "你是知识库编辑。",
	synthesisEditorPrompt: "你是知识库编辑。写出有深度的跨概念分析。",
};

const EN_PRESET: TemplateConfig = {
	language: "en",
	languageInstruction: "Write in English",
	levels: [
		{ key: "Core", label: "Core Concepts", desc: "Fundamental viewpoints and positions in your domain" },
		{ key: "Methods", label: "Methods & Frameworks", desc: "Structured tools for analysis and problem-solving" },
		{ key: "Practice", label: "Practice & Experience", desc: "Cases, reviews, and reflections from real scenarios" },
	],
	relatedLinksHeader: "Related Links",
	conflictHeader: "Knowledge Conflict",
	originalPrefix: "[Original]",
	pageRules: `- Write in English
- First line must be YAML frontmatter (wrapped in ---)
- Mark related concepts with [[ConceptName]] wikilinks on first mention
- End with ## Related Links section listing all referenced concepts/entities/sources as - [[PageName]]
- Avoid orphan pages; ensure each page links to at least 2 other pages
- Actively identify connections to existing concepts and mark with wikilinks
- Output only the complete page content, no explanations outside frontmatter`,
	analysisSystemPrompt: "You are a knowledge management expert. Output strict JSON.",
	editorSystemPrompt: "You are a knowledge base editor.",
	synthesisEditorPrompt: "You are a knowledge base editor. Write insightful cross-concept analysis.",
};

const JA_PRESET: TemplateConfig = {
	language: "ja",
	languageInstruction: "日本語で記述してください",
	levels: [
		{ key: "Core", label: "核心概念", desc: "あなたの領域における最も基本的な見解と立場" },
		{ key: "Methods", label: "手法・フレームワーク", desc: "分析と問題解決のための構造化ツール" },
		{ key: "Practice", label: "実践経験", desc: "実際のシナリオからのケース、振り返り、反省" },
	],
	relatedLinksHeader: "関連リンク",
	conflictHeader: "知識の矛盾",
	originalPrefix: "[オリジナル]",
	pageRules: `- 日本語で記述してください
- 最初の行はYAML frontmatter（--- で囲む）にしてください
- 関連概念には [[ConceptName]] ウィキリンクを最初の言及時に付与してください
- 最後に ## 関連リンク セクションを設け、すべての参照概念/エンティティ/ソースを - [[PageName]] 形式で列出してください
- 孤立ページを作らないでください。各ページは少なくとも2つの他のページにリンクしてください
- 既存の概念との関連を見つけてウィキリンクで標識してください
- frontmatter以外の説明文を出力せず、完全なページ内容のみ出力してください`,
	analysisSystemPrompt: "あなたは知識管理の専門家です。厳密なJSONを出力してください。",
	editorSystemPrompt: "あなたはナレッジベースの編集者です。",
	synthesisEditorPrompt: "あなたはナレッジベースの編集者です。深いクロス概念分析を書いてください。",
};

// 预设映射
const PRESETS: Record<string, TemplateConfig> = {
	"zh-CN": ZH_PRESET,
	"en": EN_PRESET,
	"ja": JA_PRESET,
};

export function getPreset(lang: string): TemplateConfig {
	return PRESETS[lang] || ZH_PRESET;
}

export function getPresetList(): Array<{ id: string; label: string }> {
	return [
		{ id: "zh-CN", label: "简体中文" },
		{ id: "en", label: "English" },
		{ id: "ja", label: "日本語" },
	];
}

// === 模板文件读写 ===

export const DEFAULT_TEMPLATE_PATH = "wiki/templates/prompt-config.json";

function presetToJSON(preset: TemplateConfig): string {
	return JSON.stringify(preset, null, 2);
}

// 生成模板文件到 vault
export async function generateTemplateFile(
	app: App,
	templatePath: string,
	lang: string,
): Promise<void> {
	const preset = getPreset(lang);
	const content = presetToJSON(preset);

	// 确保目录存在
	const folderPath = templatePath.substring(0, templatePath.lastIndexOf("/"));
	if (folderPath) {
		const parts = folderPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!app.vault.getAbstractFileByPath(current)) {
				await app.vault.createFolder(current);
			}
		}
	}

	const existing = app.vault.getAbstractFileByPath(templatePath);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
	} else {
		await app.vault.create(templatePath, content);
	}
}

// 从 vault 加载模板配置，合并到预设上
export async function loadTemplateConfig(
	app: App,
	templatePath: string,
	lang: string,
): Promise<TemplateConfig> {
	const preset = getPreset(lang);

	try {
		const file = app.vault.getAbstractFileByPath(templatePath);
		if (!file || !(file instanceof TFile)) return preset;

		const raw = await app.vault.read(file);
		const userConfig = JSON.parse(raw);

		// 合并：用户配置覆盖预设
		return {
			...preset,
			...userConfig,
			levels: Array.isArray(userConfig.levels) && userConfig.levels.length > 0
				? userConfig.levels
				: preset.levels,
		};
	} catch {
		return preset;
	}
}

// 获取 levels 描述映射（供 prompt 使用）
export function getLevelsDesc(config: TemplateConfig): string {
	return config.levels.map(l => `${l.key}（${l.desc}）`).join("、");
}

// 获取 levels 的 key 列表（供 JSON 输出格式使用）
export function getLevelKeys(config: TemplateConfig): string {
	return config.levels.map(l => l.key).join("|");
}

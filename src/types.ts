// 第二大脑 Obsidian 插件 — 类型定义

import type { Plugin, App } from "obsidian";

/** 与 `src/core/llm.ts` PROVIDERS 及设置面板下拉一致 */
export const LLM_PROVIDER_IDS = ["deepseek", "openai", "anthropic", "openrouter", "custom"] as const;
export type LLMProviderId = (typeof LLM_PROVIDER_IDS)[number];

/** 嵌入端：当前实现为 OpenAI 兼容 /v1/embeddings，预留 custom */
export const EMBEDDING_PROVIDER_IDS = ["openai", "custom"] as const;
export type EmbeddingProviderId = (typeof EMBEDDING_PROVIDER_IDS)[number];

export const UI_LANGUAGES = ["zh-CN", "en", "ja"] as const;
export type UILanguageId = (typeof UI_LANGUAGES)[number];

export interface PluginSettings {
	provider: LLMProviderId;
	model: string;
	apiKey: string;
	baseUrl: string;
	maxTokens: number;
	temperature: number;
	rawFolder: string;
	wikiFolder: string;
	autoCompile: boolean;
	autoCompileDelay: number;
	embeddingProvider: EmbeddingProviderId;
	embeddingModel: string;
	embeddingBaseUrl: string;
	embeddingApiKey: string;
	language: UILanguageId;
	templateFile: string;
	setupCompleted: boolean;
	licenseKey: string;
	proWelcomeShown: boolean;
	enableGapDetection: boolean;
	enableLinkEnrichment: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "deepseek" satisfies LLMProviderId,
	model: "deepseek-chat",
	apiKey: "",
	baseUrl: "https://api.deepseek.com",
	maxTokens: 8000,
	temperature: 0.3,
	rawFolder: "raw",
	wikiFolder: "wiki",
	autoCompile: true,
	autoCompileDelay: 30,
	embeddingProvider: "openai" satisfies EmbeddingProviderId,
	embeddingModel: "text-embedding-3-small",
	embeddingBaseUrl: "https://api.openai.com/v1",
	embeddingApiKey: "",
	language: "zh-CN" satisfies UILanguageId,
	templateFile: "wiki/templates/prompt-config.json",
	setupCompleted: false,
	licenseKey: "",
	proWelcomeShown: false,
	enableGapDetection: true,
	enableLinkEnrichment: true,
};

export interface RawFile {
	path: string;
	content: string;
}

export interface WikiFile {
	path: string;
	content: string;
}

export interface Concept {
	name: string;
	title: string;
	level: string;
	desc: string;
	source_file: string;
}

export interface Entity {
	name: string;
	desc: string;
}

export interface Source {
	name: string;
	source_file: string;
	desc: string;
}

export interface Synthesis {
	name: string;
	question: string;
	concepts: string[];
}

export interface Analysis {
	concepts: Concept[];
	entities: Entity[];
	sources: Source[];
	syntheses: Synthesis[];
}

export interface CompileCache {
	version: number;
	fingerprints: Record<string, Fingerprint>;
	analysis: Analysis | null;
	pages: Record<string, { key: string; generatedAt: string | null }>;
	analysisTime: string | null;
	perFileAnalysis: Record<string, Analysis>;
	indexEntries: Record<string, { type: string; level: string; name: string; title: string; desc: string }>;
	failedPages: Record<string, FailedPageEntry>;
	dependencies: Record<string, string[]>;
	gapPages?: Record<string, { name: string; detectedAt: string; referenceCount: number; level: string }>;
	compileHistory?: CompileHistoryEntry[];
	usageStats?: UsageStats;
	weeklyReportLastDate?: string;
	// v1 遗留字段，迁移后清空
	embeddings?: Record<string, number[]>;
}

export interface UsageStats {
	totalCompiles: number;
	successCompiles: number;
	failedCompiles: number;
	totalDurationMs: number;
	firstCompileAt: string | null;
	lastCompileAt: string | null;
	totalConceptsGenerated: number;
	totalEntitiesGenerated: number;
	weeklyCompiles: number;
	lastWeekDate: string;
}

/** 与磁盘 embedding 缓存绑定的 API 身份（模型/端点/维度） */
export interface EmbeddingStoreMeta {
	baseUrl: string;
	model: string;
	dim: number;
}

/** 旧格式：无 meta，加载后会在下次 flush 时按当前 settings 写入 v2 */
export interface EmbeddingStoreV1 {
	version: 1;
	embeddings: Record<string, number[]>;
}

/** 当前格式：切换 model/baseUrl 或维度不一致时丢弃缓存 */
export interface EmbeddingStoreV2 {
	version: 2;
	meta: EmbeddingStoreMeta;
	embeddings: Record<string, number[]>;
}

export type EmbeddingStore = EmbeddingStoreV1 | EmbeddingStoreV2;

export interface ValidationIssue {
	field: string;
	index: number;
	issue: string;
	value?: string;
	severity?: "error" | "warning";
}

export interface FailedPageEntry {
	name: string;
	path: string;
	error: string;
	failCount: number;
	lastFailedAt: string;
}

export interface CompileReport {
	newConcepts: Array<{ name: string; title: string; sourceFile: string }>;
	modifiedConcepts: Array<{ name: string; title: string; changeSummary: string }>;
	deletedConcepts: Array<{ name: string; title: string }>;
	validationIssues: ValidationIssue[];
	totalPages: number;
	generatedPages: number;
	skippedPages: number;
	failedPages: number;
	protectedPages: number;
	durationMs: number;
}

export interface ChangeImpact {
	rawFile: string;
	affectedPages: Array<{ name: string; type: string }>;
}

export interface CompileResult {
	conceptsCount: number;
	entitiesCount: number;
	sourcesCount: number;
	changed: number;
	skippedByDiff: number;
	generated: number;
	removed: number;
	protectedByReview: number;
	errors: Array<{ name: string; error: string; code?: string }>;
	reused: boolean;
	report?: CompileReport;
	changeImpact?: ChangeImpact[];
	gapDetected?: number;
	stubsGenerated?: number;
	linksAdded?: number;
}

export interface Fingerprint {
	m: number;
	s: number;
	h?: string;
}

export interface CompileHistoryEntry {
	date: string;
	action: "full" | "incremental" | "single";
	added: string[];
	modified: string[];
	removed: string[];
	conflicts: string[];
	durationMs: number;
	totalPages: number;
}

export interface ProgressEvent {
	step: number;
	stepName: string;
	detail: string;
	percent: number;
	pagesDone?: number;
	pagesTotal?: number;
}

// Plugin 类型带 settings（供 View 使用）
export type SecondBrainPlugin = Plugin & {
	settings: PluginSettings;
	licenseInfo: LicenseInfo;
	getLicenseState(): LicenseInfo;
	activateView(viewType: string): Promise<void>;
	saveLicenseInfo(): Promise<void>;
	saveSettings(): Promise<void>;
	runWithCompileLock<T>(fn: () => Promise<T>): Promise<T>;
	/** 将 raw 根目录散落文件移入标准子文件夹 */
	organizeRawMaterials(): Promise<void>;
};

export function openPluginSettings(app: App) {
	// Obsidian 内部 API，公开类型中未暴露 setting 对象
	const appWithSetting = app as unknown as { setting: { open(): void; openTabById(id: string): void } };
	appWithSetting.setting.open();
	appWithSetting.setting.openTabById("second-brain");
}

// License 相关类型
export interface LicenseInfo {
	key: string;
	status: "active" | "inactive" | "expired" | "invalid" | "grace" | "trial" | "none";
	plan: "free" | "pro";
	expiresAt: string | null;
	lastValidated: string | null;
	graceStart: string | null;
	trialStart: string | null;
	instanceId: string | null;
	freeChatUsed: number;
	freeChatMonth: string;
}

export const DEFAULT_LICENSE: LicenseInfo = {
	key: "",
	status: "none",
	plan: "free",
	expiresAt: null,
	lastValidated: null,
	graceStart: null,
	trialStart: null,
	instanceId: null,
	freeChatUsed: 0,
	freeChatMonth: "",
};

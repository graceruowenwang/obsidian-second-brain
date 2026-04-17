// 第二大脑 Obsidian 插件 — 类型定义

export interface PluginSettings {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl: string;
	maxTokens: number;
	temperature: number;
	rawFolder: string;
	wikiFolder: string;
	autoCompile: boolean;
	autoCompileDelay: number;
	embeddingProvider: string;
	embeddingModel: string;
	embeddingBaseUrl: string;
	embeddingApiKey: string;
	language: string;
	templateFile: string;
	setupCompleted: boolean;
	licenseKey: string;
	proWelcomeShown: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "deepseek",
	model: "deepseek-chat",
	apiKey: "",
	baseUrl: "https://api.deepseek.com",
	maxTokens: 8000,
	temperature: 0.3,
	rawFolder: "raw",
	wikiFolder: "wiki",
	autoCompile: true,
	autoCompileDelay: 30,
	embeddingProvider: "openai",
	embeddingModel: "text-embedding-3-small",
	embeddingBaseUrl: "https://api.openai.com/v1",
	embeddingApiKey: "",
	language: "zh-CN",
	templateFile: "wiki/templates/prompt-config.json",
	setupCompleted: false,
	licenseKey: "",
	proWelcomeShown: false,
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
	fingerprints: Record<string, Fingerprint>;
	analysis: Analysis | null;
	pages: Record<string, { key: string; generatedAt: string | null }>;
	analysisTime: string | null;
	perFileAnalysis: Record<string, Analysis>;
	indexEntries: Record<string, { type: string; level: string; name: string; title: string; desc: string }>;
	failedPages: Record<string, FailedPageEntry>;
	embeddings: Record<string, number[]>;
}

export interface ValidationIssue {
	field: string;
	index: number;
	issue: string;
	value?: string;
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
	errors: Array<{ name: string; error: string }>;
	reused: boolean;
	report?: CompileReport;
	changeImpact?: ChangeImpact[];
}

export interface Fingerprint {
	m: number;
	s: number;
	h?: string;
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
import type { Plugin, App } from "obsidian";
export type SecondBrainPlugin = Plugin & {
	settings: PluginSettings;
	licenseInfo: LicenseInfo;
	getLicenseState(): LicenseInfo;
	activateView(viewType: string): Promise<void>;
	saveLicenseInfo(): Promise<void>;
	saveSettings(): Promise<void>;
};

export function openPluginSettings(app: App) {
	(app as any).setting.open();
	(app as any).setting.openTabById("second-brain");
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
}

export const DEFAULT_LICENSE: LicenseInfo = {
	key: "",
	status: "none",
	plan: "free",
	expiresAt: null,
	lastValidated: null,
	graceStart: null,
	trialStart: null,
};

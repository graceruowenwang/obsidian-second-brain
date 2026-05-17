// 插件设置、提供商常量、License 类型

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
	useStreaming: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "deepseek" satisfies LLMProviderId,
	model: "deepseek-v4-flash",
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
	useStreaming: true,
};

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
	trialExpiredShown: boolean;
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
	trialExpiredShown: false,
};

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

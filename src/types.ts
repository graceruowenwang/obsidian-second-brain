// 第二大脑 Obsidian 插件 -- 类型 barrel
// 按领域拆分到 types/ 子模块，本文件统一 re-export，消费方无需改动

export {
	LLM_PROVIDER_IDS, EMBEDDING_PROVIDER_IDS, UI_LANGUAGES,
	DEFAULT_SETTINGS, DEFAULT_LICENSE,
	openPluginSettings,
	type LLMProviderId, type EmbeddingProviderId, type UILanguageId,
	type PluginSettings, type LicenseInfo, type SecondBrainPlugin,
} from "./types/settings";

export {
	type RawFile, type WikiFile,
	type Concept, type Entity, type Source, type Synthesis, type Analysis,
	type Fingerprint, type FailedPageEntry, type ValidationIssue, type UsageStats,
	type CompileCache, type CompileHistoryEntry,
	type CompileReport, type ChangeImpact, type CompileResult, type ProgressEvent,
} from "./types/compile";

export {
	type EmbeddingStoreMeta, type EmbeddingStoreV1, type EmbeddingStoreV2, type EmbeddingStore,
} from "./types/api";

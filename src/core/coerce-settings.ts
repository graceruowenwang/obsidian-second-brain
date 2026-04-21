// 从 data.json 合并后的 settings 纠偏 — 防止旧数据/手改 JSON 导致非法枚举

import {
	DEFAULT_SETTINGS,
	EMBEDDING_PROVIDER_IDS,
	LLM_PROVIDER_IDS,
	UI_LANGUAGES,
	type PluginSettings,
} from "../types";

function normalizeFolderPath(input: string, fallback: string): string {
	const trimmed = (input || "").trim();
	if (!trimmed) return fallback;
	// Vault path should be relative (no leading slash), and without trailing slash.
	const normalized = trimmed
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+/g, "/")
		.replace(/\/+$/, "");
	return normalized || fallback;
}

export function coercePluginSettings(settings: PluginSettings): void {
	if (!(LLM_PROVIDER_IDS as readonly string[]).includes(settings.provider)) {
		console.warn(`second-brain: invalid provider "${String(settings.provider)}", reset to ${DEFAULT_SETTINGS.provider}`);
		settings.provider = DEFAULT_SETTINGS.provider;
	}
	if (!(EMBEDDING_PROVIDER_IDS as readonly string[]).includes(settings.embeddingProvider)) {
		console.warn(`second-brain: invalid embeddingProvider "${String(settings.embeddingProvider)}", reset to default`);
		settings.embeddingProvider = DEFAULT_SETTINGS.embeddingProvider;
	}
	if (!(UI_LANGUAGES as readonly string[]).includes(settings.language)) {
		console.warn(`second-brain: invalid language "${String(settings.language)}", reset to ${DEFAULT_SETTINGS.language}`);
		settings.language = DEFAULT_SETTINGS.language;
	}
	if (typeof settings.maxTokens !== "number" || !Number.isFinite(settings.maxTokens) || settings.maxTokens < 1) {
		settings.maxTokens = DEFAULT_SETTINGS.maxTokens;
	}
	if (typeof settings.temperature !== "number" || !Number.isFinite(settings.temperature)) {
		settings.temperature = DEFAULT_SETTINGS.temperature;
	} else {
		settings.temperature = Math.min(2, Math.max(0, settings.temperature));
	}
	if (typeof settings.autoCompileDelay !== "number" || !Number.isFinite(settings.autoCompileDelay) || settings.autoCompileDelay < 1) {
		settings.autoCompileDelay = DEFAULT_SETTINGS.autoCompileDelay;
	}
	settings.rawFolder = normalizeFolderPath(settings.rawFolder, DEFAULT_SETTINGS.rawFolder);
	settings.wikiFolder = normalizeFolderPath(settings.wikiFolder, DEFAULT_SETTINGS.wikiFolder);
}

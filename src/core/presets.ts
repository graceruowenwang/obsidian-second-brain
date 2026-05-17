// Provider 预设配置 -- 快速配置 LLM

import type { LLMProviderId } from "../types";

export interface ProviderPreset {
	label: string;
	models: string[];
	baseUrl: string;
	keyUrl: string;
}

export const PROVIDER_PRESETS: Record<Exclude<LLMProviderId, "custom">, ProviderPreset> = {
	deepseek: {
		label: "DeepSeek",
		models: ["deepseek-v4-flash", "deepseek-v4-pro"],
		baseUrl: "https://api.deepseek.com",
		keyUrl: "https://platform.deepseek.com/api_keys",
	},
	openai: {
		label: "OpenAI",
		models: ["gpt-4o", "gpt-4o-mini"],
		baseUrl: "https://api.openai.com/v1",
		keyUrl: "https://platform.openai.com/api-keys",
	},
	anthropic: {
		label: "Anthropic (Claude)",
		models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
		baseUrl: "https://api.anthropic.com/v1",
		keyUrl: "https://console.anthropic.com/settings/keys",
	},
	openrouter: {
		label: "OpenRouter",
		models: ["openai/gpt-4o", "anthropic/claude-sonnet-4-20250514"],
		baseUrl: "https://openrouter.ai/api/v1",
		keyUrl: "https://openrouter.ai/keys",
	},
};

/** custom 无预设；其余返回对应配置 */
export function providerPresetOrUndefined(provider: LLMProviderId): ProviderPreset | undefined {
	if (provider === "custom") return undefined;
	return PROVIDER_PRESETS[provider];
}

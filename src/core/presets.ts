// Provider 预设配置 -- 快速配置 LLM

export interface ProviderPreset {
	label: string;
	models: string[];
	baseUrl: string;
	keyUrl: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
	deepseek: {
		label: "DeepSeek",
		models: ["deepseek-chat", "deepseek-reasoner"],
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

// LLM 适配器 — 使用 Obsidian requestUrl
// 从 llm.js 移植，fetch → requestUrl，配置从 plugin.settings 读取

import { requestUrl } from "obsidian";
import type { PluginSettings } from "../types";

export interface LLMOptions {
	temperature?: number;
	maxTokens?: number;
	jsonMode?: boolean;
	maxRetries?: number;
	signal?: AbortSignal;
}

// DeepSeek / OpenAI / OpenRouter / 任何 OpenAI 兼容 API
async function callOpenAICompatible(
	messages: Array<{ role: string; content: string }>,
	options: LLMOptions,
	settings: PluginSettings
): Promise<string> {
	const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
	const res = await requestUrl({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${settings.apiKey}`,
		},
		body: JSON.stringify({
			model: settings.model,
			messages,
			temperature: options.temperature ?? settings.temperature,
			max_tokens: options.maxTokens ?? settings.maxTokens,
			...(options.jsonMode ? { response_format: { type: "json_object" } } : {}),
		}),
	});
	return res.json.choices[0].message.content;
}

// Anthropic Claude
async function callAnthropic(
	messages: Array<{ role: string; content: string }>,
	options: LLMOptions,
	settings: PluginSettings
): Promise<string> {
	const systemMsg = messages.find((m) => m.role === "system");
	const chatMsgs = messages
		.filter((m) => m.role !== "system")
		.map((m) => ({ role: m.role, content: m.content }));

	const url = settings.baseUrl.replace(/\/+$/, "") + "/messages";
	const res = await requestUrl({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": settings.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: settings.model,
			max_tokens: options.maxTokens ?? settings.maxTokens,
			...(systemMsg ? { system: systemMsg.content } : {}),
			messages: chatMsgs,
		}),
	});
	return res.json.content[0].text;
}

const PROVIDERS: Record<string, typeof callOpenAICompatible> = {
	deepseek: callOpenAICompatible,
	openai: callOpenAICompatible,
	openrouter: callOpenAICompatible,
	custom: callOpenAICompatible,
	anthropic: callAnthropic,
};

export async function callLLM(
	messages: Array<{ role: string; content: string }>,
	settings: PluginSettings,
	options: LLMOptions = {}
): Promise<string> {
	const adapter = PROVIDERS[settings.provider];
	if (!adapter) {
		throw new Error(`不支持的 provider: ${settings.provider}`);
	}

	const maxRetries = options.maxRetries ?? 1;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await adapter(messages, options, settings);
		} catch (e: any) {
			const isAuthError = e.message?.includes("401") || e.message?.includes("403");
			if (attempt < maxRetries && !isAuthError) {
				await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
				continue;
			}
			throw e;
		}
	}
	throw new Error("LLM 调用失败");
}

// 流式调用（对话面板用，桌面端 fetch 可用）
export async function callLLMStream(
	messages: Array<{ role: string; content: string }>,
	settings: PluginSettings,
	onChunk: (text: string) => void,
	options: LLMOptions = {}
): Promise<string> {
	if (settings.provider === "anthropic") {
		return callAnthropicStream(messages, settings, onChunk, options);
	}
	return callOpenAIStream(messages, settings, onChunk, options);
}

async function callOpenAIStream(
	messages: Array<{ role: string; content: string }>,
	settings: PluginSettings,
	onChunk: (text: string) => void,
	options: LLMOptions = {}
): Promise<string> {
	const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${settings.apiKey}`,
		},
		body: JSON.stringify({
			model: settings.model,
			messages,
			temperature: options.temperature ?? 0.5,
			max_tokens: options.maxTokens ?? 3000,
			stream: true,
		}),
		signal: options.signal,
	});

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`API 错误 (${res.status}): ${err}`);
	}

	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let fullText = "";
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			if (line === "data: [DONE]") continue;
			try {
				const d = JSON.parse(line.slice(6));
				const text = d.choices?.[0]?.delta?.content || "";
				if (text) {
					fullText += text;
					onChunk(text);
				}
			} catch {}
		}
	}
	return fullText;
}

async function callAnthropicStream(
	messages: Array<{ role: string; content: string }>,
	settings: PluginSettings,
	onChunk: (text: string) => void,
	options: LLMOptions = {}
): Promise<string> {
	const systemMsg = messages.find((m) => m.role === "system");
	const chatMsgs = messages
		.filter((m) => m.role !== "system")
		.map((m) => ({ role: m.role, content: m.content }));

	const url = settings.baseUrl.replace(/\/+$/, "") + "/messages";
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": settings.apiKey,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: settings.model,
			max_tokens: options.maxTokens ?? 3000,
			...(systemMsg ? { system: systemMsg.content } : {}),
			messages: chatMsgs,
			stream: true,
		}),
		signal: options.signal,
	});

	if (!res.ok) {
		const err = await res.text();
		throw new Error(`API 错误 (${res.status}): ${err}`);
	}

	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let fullText = "";
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				const d = JSON.parse(line.slice(6));
				if (d.type === "content_block_delta" && d.delta?.text) {
					fullText += d.delta.text;
					onChunk(d.delta.text);
				}
			} catch {}
		}
	}
	return fullText;
}

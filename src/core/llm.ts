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
				temperature: options.temperature ?? settings.temperature,
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

	const maxRetries = options.maxRetries ?? 2;
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await adapter(messages, options, settings);
		} catch (e: unknown) {
			lastError = e instanceof Error ? e : new Error(String(e));
			const status = (e as any)?.status || 0;
			if (status === 401 || status === 403) throw e;
			if (status === 429 && attempt < maxRetries) {
				await new Promise(r => setTimeout(r, Math.min(5000 * Math.pow(2, attempt), 60000)));
				continue;
			}
			if (attempt < maxRetries) {
				await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 30000)));
				continue;
			}
			throw e;
		}
	}
	throw lastError;
}

// 批量调用：每个任务独立重试，批次间可配延迟
export interface BatchTask {
	messages: Array<{ role: string; content: string }>;
	options: LLMOptions;
}

export interface BatchResult {
	index: number;
	status: "fulfilled" | "rejected";
	value?: string;
	reason?: string;
}

export interface BatchOptions {
	concurrency?: number;       // 并发数，默认 5
	batchDelay?: number;        // 批次间延迟 ms，默认 500
	perItemRetry?: number;      // 单项重试次数，默认 3
	signal?: AbortSignal;
}

export async function callLLMBatch(
	tasks: BatchTask[],
	settings: PluginSettings,
	batchOpts: BatchOptions = {},
): Promise<BatchResult[]> {
	const concurrency = batchOpts.concurrency ?? 5;
	const batchDelay = batchOpts.batchDelay ?? 500;
	const perItemRetry = batchOpts.perItemRetry ?? 3;
	const results: BatchResult[] = new Array(tasks.length);

	for (let i = 0; i < tasks.length; i += concurrency) {
		if (batchOpts.signal?.aborted) {
			for (let j = i; j < tasks.length; j++) {
				results[j] = { index: j, status: "rejected", reason: "编译已取消" };
			}
			break;
		}

		const batch = tasks.slice(i, i + concurrency);
		const batchResults = await Promise.allSettled(batch.map(async (task, idx) => {
			const globalIdx = i + idx;
			let lastErr: string = "未知错误";
			for (let attempt = 0; attempt <= perItemRetry; attempt++) {
				try {
					const value = await callLLM(task.messages, settings, {
						...task.options,
						signal: batchOpts.signal,
					});
					return { index: globalIdx, status: "fulfilled" as const, value };
				} catch (e) {
					lastErr = e instanceof Error ? e.message : String(e);
					if (attempt < perItemRetry) {
						const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
						await new Promise(r => setTimeout(r, delay));
					}
				}
			}
			return { index: globalIdx, status: "rejected" as const, reason: lastErr };
		}));

		for (let j = 0; j < batchResults.length; j++) {
			const r = batchResults[j];
			if (r.status === "fulfilled") {
				results[r.value.index] = r.value;
			} else {
				const idx = i + j;
				results[idx] = { index: idx, status: "rejected", reason: String((r as PromiseRejectedResult).reason || "未知错误") };
			}
		}

		// 批次间延迟，防止限流
		if (i + concurrency < tasks.length && batchDelay > 0) {
			await new Promise(r => setTimeout(r, batchDelay));
		}
	}

	return results;
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

	if (!res.body) throw new Error("API 返回了空响应体");
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
		try {
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
			} catch (e) { console.warn("llm:", e) }
		}
	}
			return fullText;
		} finally {
			reader.cancel();
		}
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

	if (!res.body) throw new Error("API 返回了空响应体");
	const reader = res.body.getReader();
		try {
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
			} catch (e) { console.warn("llm:", e) }
		}
	}
			return fullText;
		} finally {
			reader.cancel();
		}
}

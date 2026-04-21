// LLM 适配器 — 使用 Obsidian requestUrl
// 从 llm.js 移植，fetch → requestUrl，配置从 plugin.settings 读取

import { requestUrl } from "obsidian";
import type { LLMProviderId, PluginSettings } from "../types";

export interface LLMOptions {
	temperature?: number;
	maxTokens?: number;
	jsonMode?: boolean;
	maxRetries?: number;
	signal?: AbortSignal;
}

// 判定 HTTP 状态是否可重试：429 / 5xx / 网络错误（status=0）可重试，4xx 其他不可
function isRetryableStatus(status: number): boolean {
	if (status === 0) return true; // 网络错误
	if (status === 429) return true;
	if (status >= 500 && status < 600) return true;
	return false;
}

export type LLMErrorCode =
	| "network"
	| "timeout"
	| "cancelled"
	| "rate_limit"
	| "auth"
	| "not_found"
	| "bad_request"
	| "context_length"
	| "server"
	| "invalid_response"
	| "unknown";

function tryParseOpenAIStyleError(body: string): { code?: string; message?: string } | null {
	const t = body.trim();
	if (!t.startsWith("{")) return null;
	try {
		const j = JSON.parse(t) as { error?: { code?: string; message?: string }; code?: string };
		const err = j?.error;
		if (err && typeof err === "object") {
			return {
				code: typeof err.code === "string" ? err.code : undefined,
				message: typeof err.message === "string" ? err.message : undefined,
			};
		}
		if (typeof j?.code === "string") return { code: j.code };
	} catch {
		/* 截断或非 JSON */
	}
	return null;
}

/** 由 HTTP 状态 + 响应体推断错误类别，供 UI 映射固定文案 */
export function inferLLMErrorCode(status: number, body?: string, message?: string): LLMErrorCode {
	const b = (body || "").toLowerCase();
	const m = (message || "").toLowerCase();
	const blob = `${b} ${m}`;
	const parsed = body ? tryParseOpenAIStyleError(body) : null;
	const oc = parsed?.code?.toLowerCase();
	const om = (parsed?.message || "").toLowerCase();

	if (oc === "context_length_exceeded" || oc === "string_above_max_length" || om.includes("maximum context")) {
		return "context_length";
	}
	if (oc === "rate_limit_exceeded" || oc === "insufficient_quota") return "rate_limit";
	if (oc === "invalid_api_key" || oc === "incorrect_api_key") return "auth";

	if (status === 429) return "rate_limit";
	if (status === 401 || status === 403) return "auth";
	if (status === 404) return "not_found";
	if (status >= 500 && status < 600) return "server";
	if (status === 400) {
		if (blob.includes("context_length") || blob.includes("maximum context") || (blob.includes("token") && blob.includes("limit")) || blob.includes("length")) {
			return "context_length";
		}
		return "bad_request";
	}
	if (status === 0) {
		if (blob.includes("abort") || m.includes("aborted")) return "cancelled";
		if (blob.includes("timeout") || blob.includes("etimedout") || blob.includes("timed out")) return "timeout";
		return "network";
	}
	if (status === 200 || status === 201) {
		if (blob.includes("sb_llm_no_content") || blob.includes("choices[0]") || blob.includes("content[0].text")) return "invalid_response";
		return "unknown";
	}
	if (blob.includes("context_length") || blob.includes("maximum context")) return "context_length";
	if (blob.includes("invalid api key") || blob.includes("incorrect api key")) return "auth";
	return "unknown";
}

// 统一异常类型，便于重试决策与 UI 映射
export class LLMError extends Error {
	readonly status: number;
	readonly retryable: boolean;
	readonly body?: string;
	readonly code: LLMErrorCode;

	constructor(
		message: string,
		status: number = 0,
		retryable: boolean = false,
		body?: string,
		code?: LLMErrorCode,
	) {
		super(message);
		this.name = "LLMError";
		this.status = status;
		this.retryable = retryable;
		this.body = body;
		this.code = code ?? inferLLMErrorCode(status, body, message);
	}
}

function tryStringify(v: unknown): string {
	try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); }
}

// DeepSeek / OpenAI / OpenRouter / 任何 OpenAI 兼容 API
async function callOpenAICompatible(
	messages: Array<{ role: string; content: string }>,
	options: LLMOptions,
	settings: PluginSettings
): Promise<string> {
	const url = settings.baseUrl.replace(/\/+$/, "") + "/chat/completions";
	if (options.signal?.aborted) throw new LLMError("SB_CANCELLED", 0, false);
	let res;
	try {
		res = await requestUrl({
			url,
			method: "POST",
			throw: false,
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
	} catch (e) {
		// 网络/DNS/超时 → 可重试
		throw new LLMError(`SB_LLM_NETWORK: ${(e as Error).message}`, 0, true);
	}

	if (res.status < 200 || res.status >= 300) {
		const bodyText = tryStringify(res.json ?? res.text);
		throw new LLMError(
			`API ${res.status}: ${bodyText.slice(0, 300)}`,
			res.status,
			isRetryableStatus(res.status),
			bodyText,
		);
	}

	const content = res.json?.choices?.[0]?.message?.content;
	if (typeof content !== "string") {
		const bodySnippet = tryStringify(res.json).slice(0, 300);
		throw new LLMError(
			`SB_LLM_NO_CONTENT(openai): ${bodySnippet}`,
			200,
			false,
			bodySnippet,
			"invalid_response",
		);
	}
	return content;
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
	if (options.signal?.aborted) throw new LLMError("SB_CANCELLED", 0, false);
	let res;
	try {
		res = await requestUrl({
			url,
			method: "POST",
			throw: false,
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
	} catch (e) {
		throw new LLMError(`SB_LLM_NETWORK: ${(e as Error).message}`, 0, true);
	}

	if (res.status < 200 || res.status >= 300) {
		const bodyText = tryStringify(res.json ?? res.text);
		throw new LLMError(
			`API ${res.status}: ${bodyText.slice(0, 300)}`,
			res.status,
			isRetryableStatus(res.status),
			bodyText,
		);
	}

	const text = res.json?.content?.[0]?.text;
	if (typeof text !== "string") {
		const detail = tryStringify(res.json).slice(0, 300);
		throw new LLMError(
			`SB_LLM_NO_CONTENT(anthropic): ${detail}`,
			200,
			false,
			detail,
			"invalid_response",
		);
	}
	return text;
}

type LLMAdapter = (
	messages: Array<{ role: string; content: string }>,
	options: LLMOptions,
	settings: PluginSettings,
) => Promise<string>;

const PROVIDERS: Record<LLMProviderId, LLMAdapter> = {
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

	const maxRetries = options.maxRetries ?? 2;
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await adapter(messages, options, settings);
		} catch (e: unknown) {
			const err = e instanceof Error ? e : new Error(String(e));
			lastError = err;

			// 只有 LLMError 标注为 retryable 的错误才重试；其它一律立即抛出。
			// 这避免了"内容违规 / context too long / 模型不存在"类 4xx 被盲目重试浪费 token。
			const retryable = err instanceof LLMError && err.retryable;
			if (!retryable || attempt >= maxRetries) {
				throw err;
			}
			// 429 用较长 backoff，其它可重试错误用标准 backoff
			const base = err instanceof LLMError && err.status === 429 ? 5000 : 1000;
			const maxDelay = err instanceof LLMError && err.status === 429 ? 60000 : 30000;
			const delay = Math.min(base * Math.pow(2, attempt) + Math.random() * base * 0.5, maxDelay);
			if (options.signal?.aborted) throw err;
			await new Promise(r => setTimeout(r, delay));
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
	/** 仅当 status=rejected 且来自 LLMError 时有值 */
	llmCode?: LLMErrorCode;
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
				results[j] = { index: j, status: "rejected", reason: "SB_CANCELLED" };
			}
			break;
		}

		const batch = tasks.slice(i, i + concurrency);
		const batchResults = await Promise.allSettled(batch.map(async (task, idx) => {
			const globalIdx = i + idx;
			try {
				const value = await callLLM(task.messages, settings, {
					...task.options,
					maxRetries: perItemRetry,
					signal: batchOpts.signal,
				});
				return { index: globalIdx, status: "fulfilled" as const, value };
			} catch (e) {
				if (e instanceof LLMError) {
					return { index: globalIdx, status: "rejected" as const, reason: e.message, llmCode: e.code };
				}
				const reason = e instanceof Error ? e.message : String(e);
				return { index: globalIdx, status: "rejected" as const, reason };
			}
		}));

		for (let j = 0; j < batchResults.length; j++) {
			const r = batchResults[j];
			if (r.status === "fulfilled") {
				results[r.value.index] = r.value;
			} else {
				const idx = i + j;
				results[idx] = { index: idx, status: "rejected", reason: String((r as PromiseRejectedResult).reason || "SB_UNKNOWN") };
			}
		}

		// 批次间延迟，防止限流
		if (i + concurrency < tasks.length && batchDelay > 0) {
			await new Promise(r => setTimeout(r, batchDelay));
		}
	}

	return results;
}

/**
 * 流式调用（对话面板）。
 * 使用浏览器 `fetch` + `ReadableStream` 读取 SSE：Obsidian 的 `requestUrl` 无法消费增量 body，
 * 故与 `callLLM` 的 `requestUrl` 路径分离；非流式请求仍以 `requestUrl` 为准（含移动端）。
 */
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

/** 连续 SSE JSON 解析失败上限，避免半包/乱流时界面无限转圈 */
const STREAM_SSE_MAX_PARSE_FAILURES = 15;

// --- 共享 SSE 流读取器 ---

interface StreamConfig {
	url: string;
	headers: Record<string, string>;
	body: string;
	signal?: AbortSignal;
	/** 从 SSE data 行解析出文本片段，返回 undefined 表示忽略该行 */
	extractText: (parsed: unknown) => string | undefined;
	/** 是否跳过 "data: [DONE]" 终止行 */
	skipDoneLine?: boolean;
}

async function readSSEStream(config: StreamConfig, onChunk: (text: string) => void): Promise<string> {
	let res: Response;
	try {
		res = await fetch(config.url, {
			method: "POST",
			headers: config.headers,
			body: config.body,
			signal: config.signal,
		});
	} catch (e) {
		throw new LLMError(`SB_LLM_STREAM_NETWORK: ${(e as Error).message}`, 0, true);
	}

	if (!res.ok) {
		const err = await res.text();
		throw new LLMError(
			`API error (${res.status}): ${err.slice(0, 500)}`,
			res.status,
			isRetryableStatus(res.status),
			err,
		);
	}

	if (!res.body) {
		throw new LLMError("SB_LLM_EMPTY_BODY", res.status || 0, false, undefined, "invalid_response");
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let fullText = "";
	let buffer = "";
	let sseParseFailures = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				if (config.skipDoneLine && line === "data: [DONE]") continue;
				try {
					const d = JSON.parse(line.slice(6));
					sseParseFailures = 0;
					const text = config.extractText(d);
					if (text) {
						fullText += text;
						onChunk(text);
					}
				} catch (e) {
					sseParseFailures++;
					if (sseParseFailures >= STREAM_SSE_MAX_PARSE_FAILURES) {
						throw new LLMError(
							`SSE parse failed consecutively (${STREAM_SSE_MAX_PARSE_FAILURES} times), please retry`,
							0,
							false,
							line.slice(0, 200),
							"invalid_response",
						);
					}
					console.warn("llm: SSE parse", e);
				}
			}
		}
		return fullText;
	} finally {
		try { await reader.cancel(); } catch { /* ignore */ }
	}
}

// --- 提供商特定的流式构建 ---

async function callOpenAIStream(
	messages: Array<{ role: string; content: string }>,
	settings: PluginSettings,
	onChunk: (text: string) => void,
	options: LLMOptions = {}
): Promise<string> {
	return readSSEStream({
		url: settings.baseUrl.replace(/\/+$/, "") + "/chat/completions",
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
		skipDoneLine: true,
		extractText: (d: any) => d.choices?.[0]?.delta?.content || undefined,
	}, onChunk);
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

	return readSSEStream({
		url: settings.baseUrl.replace(/\/+$/, "") + "/messages",
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
		extractText: (d: any) =>
			d.type === "content_block_delta" && d.delta?.text ? d.delta.text : undefined,
	}, onChunk);
}

/** 判断错误是否为 fetch 不可用 / 网络不通 */
function isFetchNetworkError(e: unknown): boolean {
	if (e instanceof LLMError && e.code === "network") return true;
	const msg = e instanceof Error ? e.message : String(e);
	const lower = msg.toLowerCase();
	return lower.includes("failed to fetch")
		|| lower.includes("networkerror")
		|| lower.includes("fetch is not defined")
		|| lower.includes("network request failed");
}

/**
 * 带自动降级的流式调用。
 * - useStreaming=false 时直接走非流式 requestUrl
 * - 流式失败（fetch 不可用 / 网络错误）时自动降级为非流式 + 模拟分块
 */
export async function callLLMStreamWithFallback(
	messages: Array<{ role: string; content: string }>,
	settings: PluginSettings,
	onChunk: (text: string) => void,
	options: LLMOptions = {}
): Promise<string> {
	// 设置关闭流式 → 直接走非流式
	if (!settings.useStreaming) {
		return nonStreamingFallback(messages, settings, onChunk, options);
	}

	try {
		return await callLLMStream(messages, settings, onChunk, options);
	} catch (e) {
		// 仅对 fetch 网络错误降级，其它错误照常抛出
		if (isFetchNetworkError(e)) {
			console.warn("llm: streaming failed, falling back to requestUrl", e instanceof Error ? e.message : e);
			return nonStreamingFallback(messages, settings, onChunk, options);
		}
		throw e;
	}
}

/** 非流式降级：用 requestUrl 获取完整响应，再按段落模拟分块回传 */
async function nonStreamingFallback(
	messages: Array<{ role: string; content: string }>,
	settings: PluginSettings,
	onChunk: (text: string) => void,
	options: LLMOptions = {}
): Promise<string> {
	const fullText = await callLLM(messages, settings, options);
	// 按段落/换行拆分，模拟流式体验
	const chunks = splitIntoChunks(fullText, 80);
	for (const chunk of chunks) {
		onChunk(chunk);
	}
	return fullText;
}

function splitIntoChunks(text: string, maxLen: number): string[] {
	const parts: string[] = [];
	let i = 0;
	while (i < text.length) {
		// 优先在换行处切割
		let end = Math.min(i + maxLen, text.length);
		if (end < text.length) {
			const nl = text.lastIndexOf("\n", end);
			if (nl > i) end = nl + 1;
		}
		parts.push(text.slice(i, end));
		i = end;
	}
	return parts;
}

import { describe, it, expect } from "vitest";
import { LLMError, inferLLMErrorCode } from "../llm";

describe("LLMError", () => {
	it("保留 status、retryable、body、code 字段", () => {
		const e = new LLMError("boom", 429, true, '{"err":"rate"}');
		expect(e.name).toBe("LLMError");
		expect(e.message).toBe("boom");
		expect(e.status).toBe(429);
		expect(e.retryable).toBe(true);
		expect(e.body).toBe('{"err":"rate"}');
		expect(e.code).toBe("rate_limit");
	});

	it("可重试与不可重试默认值", () => {
		const e = new LLMError("x");
		expect(e.status).toBe(0);
		expect(e.retryable).toBe(false);
		expect(e.code).toBe("network");
	});

	it("显式 code 覆盖推断", () => {
		const e = new LLMError("m", 400, false, "{}", "bad_request");
		expect(e.code).toBe("bad_request");
	});
});

describe("inferLLMErrorCode", () => {
	it("解析 OpenAI error.code", () => {
		const body = JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } });
		expect(inferLLMErrorCode(400, body)).toBe("context_length");
	});

	it("401 → auth", () => {
		expect(inferLLMErrorCode(401, "{}")).toBe("auth");
	});

	it("429 → rate_limit", () => {
		expect(inferLLMErrorCode(429, "")).toBe("rate_limit");
	});

	it("503 → server", () => {
		expect(inferLLMErrorCode(503, "")).toBe("server");
	});

	it("截断或非 JSON 响应体不抛错", () => {
		expect(inferLLMErrorCode(400, "not json")).toBe("bad_request");
	});

	it("invalid_api_key 在 body 中 → auth", () => {
		const body = JSON.stringify({ error: { code: "invalid_api_key", message: "bad" } });
		expect(inferLLMErrorCode(401, body)).toBe("auth");
	});

	it("status 0 + timeout 字样 → timeout", () => {
		expect(inferLLMErrorCode(0, "fetch timed out")).toBe("timeout");
	});
});

// 这里不直接测 callLLM 的端到端，因为它依赖 requestUrl（obsidian mock 会返回空 200）。
// 重点是 retry 决策语义——通过手工模拟一个 adapter 验证 callLLM 的分支。
// 若未来需要真正覆盖这部分，建议把 "decide if retry" 提炼为独立纯函数。

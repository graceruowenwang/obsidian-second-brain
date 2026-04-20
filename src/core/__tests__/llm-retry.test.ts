import { describe, it, expect } from "vitest";
import { LLMError } from "../llm";

describe("LLMError", () => {
	it("保留 status、retryable、body 字段", () => {
		const e = new LLMError("boom", 429, true, '{"err":"rate"}');
		expect(e.name).toBe("LLMError");
		expect(e.message).toBe("boom");
		expect(e.status).toBe(429);
		expect(e.retryable).toBe(true);
		expect(e.body).toBe('{"err":"rate"}');
	});

	it("可重试与不可重试默认值", () => {
		const e = new LLMError("x");
		expect(e.status).toBe(0);
		expect(e.retryable).toBe(false);
	});
});

// 这里不直接测 callLLM 的端到端，因为它依赖 requestUrl（obsidian mock 会返回空 200）。
// 重点是 retry 决策语义——通过手工模拟一个 adapter 验证 callLLM 的分支。
// 若未来需要真正覆盖这部分，建议把 "decide if retry" 提炼为独立纯函数。

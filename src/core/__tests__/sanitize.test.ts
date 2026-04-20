import { describe, it, expect } from "vitest";
import { sanitizeLLMOutput } from "../sanitize";

describe("sanitizeLLMOutput", () => {
	it("移除 script 及其内部文本", () => {
		expect(sanitizeLLMOutput(`<p>ok</p><script>alert(1)</script>`)).not.toContain("alert");
		expect(sanitizeLLMOutput(`<p>ok</p><script>alert(1)</script>`)).toContain("ok");
	});

	it("剥离 javascript: / data: 链接", () => {
		const out = sanitizeLLMOutput(`<a href="javascript:alert(1)">x</a>`);
		expect(out.toLowerCase()).not.toContain("javascript:");
		expect(out).toMatch(/href=["']#["']/);
	});

	it("移除 img 上的 onerror", () => {
		const out = sanitizeLLMOutput(`<img src="x" onerror="alert(1)" alt="i">`);
		expect(out.toLowerCase()).not.toContain("onerror");
	});

	it("纯文本保持不变", () => {
		expect(sanitizeLLMOutput("hello **md**")).toBe("hello **md**");
	});

	it("不破坏 Markdown 角括号链接 <https://...>", () => {
		const s = "see <https://example.com/path> ok";
		expect(sanitizeLLMOutput(s)).toBe(s);
	});

	it("移除非白名单 HTML 标签 token", () => {
		const out = sanitizeLLMOutput(`<x-custom>in</x-custom>`);
		expect(out).toContain("in");
		expect(out).not.toContain("x-custom");
	});

	it("比较运算符 a < b 不被当成标签", () => {
		expect(sanitizeLLMOutput("if a < b then")).toBe("if a < b then");
	});
});

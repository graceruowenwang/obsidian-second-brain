import { describe, it, expect } from "vitest";
import { findRelevantPages, filesToMap } from "../keyword-search";

describe("findRelevantPages", () => {
	const files: Record<string, string> = {
		"concepts/TestMethod.md": "这是一个关于测试方法的概念页面。包含 [[UnitTest]] 和 [[IntegrationTest]]。",
		"concepts/DeepLearning.md": "深度学习是机器学习的子领域。使用神经网络。",
		"entities/OpenAI.md": "OpenAI 是一家人工智能公司。",
	};

	it("returns results matching keywords", () => {
		const results = findRelevantPages("测试方法", files, 5);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].filePath).toContain("TestMethod");
	});

	it("respects topN limit", () => {
		const results = findRelevantPages("test", files, 1);
		expect(results.length).toBeLessThanOrEqual(1);
	});

	it("returns empty for no matches", () => {
		const results = findRelevantPages("量子计算xyz不存在", files, 5);
		expect(results.length).toBe(0);
	});

	it("does not generate excessive substrings for long keywords", () => {
		// This should not hang or produce excessive substrings
		const results = findRelevantPages("这是一个非常非常长的查询字符串用于测试关键词截断行为", files, 5);
		expect(Array.isArray(results)).toBe(true);
	});
});

describe("filesToMap", () => {
	it("converts array to map", () => {
		const files = [
			{ path: "a.md", content: "hello" },
			{ path: "b.md", content: "world" },
		];
		const map = filesToMap(files);
		expect(map["a.md"]).toBe("hello");
		expect(map["b.md"]).toBe("world");
	});

	it("returns empty for empty array", () => {
		expect(Object.keys(filesToMap([]))).toHaveLength(0);
	});
});

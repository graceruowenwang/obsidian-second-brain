import { describe, it, expect } from "vitest";
import { findRelevantMaterialsByKeyword } from "../compile-materials";

describe("findRelevantMaterialsByKeyword", () => {
	it("returns empty when no files match keywords", () => {
		const result = findRelevantMaterialsByKeyword(
			"UnrelatedTopic",
			"",
			[{ path: "raw/01-articles/cooking.md", content: "Cooking content about pasta and sauce." }],
		);
		// fallback returns first 2 files when nothing matches
		expect(result).toContain("cooking.md");
	});

	it("scores title matches highest", () => {
		const files = [
			{ path: "raw/01-articles/Topic.md", content: "Generic content about Topic." },
			{ path: "raw/01-articles/TopicDeep.md", content: "Topic appears in body. Topic is repeated. Topic again." },
		];
		const result = findRelevantMaterialsByKeyword("Topic", "", files);
		// Both match, but Topic.md should appear first (title match = 8pts each)
		expect(result).toContain("Topic.md");
		expect(result).toContain("TopicDeep.md");
	});

	it("respects maxChars limit", () => {
		const files = Array.from({ length: 10 }, (_, i) => ({
			path: `raw/01-articles/Test${i}.md`,
			content: "Topic content. ".repeat(200),
		}));
		const result = findRelevantMaterialsByKeyword("Test", "", files, 500);
		expect(result.length).toBeLessThanOrEqual(500);
	});

	it("extracts keywords from TitleCase name", () => {
		const files = [
			{ path: "raw/01-articles/doc.md", content: "This discusses Retrieval Augmented Generation methods." },
		];
		const result = findRelevantMaterialsByKeyword("RetrievalAugmentedGeneration", "RAG technique", files);
		expect(result.length).toBeGreaterThan(0);
	});

	it("falls back to first 2 files when no keywords match", () => {
		const files = [
			{ path: "raw/01-articles/a.md", content: "aaa" },
			{ path: "raw/01-articles/b.md", content: "bbb" },
			{ path: "raw/01-articles/c.md", content: "ccc" },
		];
		const result = findRelevantMaterialsByKeyword("Z", "", files);
		expect(result).toContain("a.md");
		expect(result).toContain("b.md");
		expect(result).not.toContain("c.md");
	});
});

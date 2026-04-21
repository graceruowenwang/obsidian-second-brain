import { describe, it, expect } from "vitest";
import { buildPageIndex, enrichPageWithLinks, escapeRegex } from "../compile-link-enrichment";
import type { LinkSuggestion } from "../compile-link-enrichment";
import type { TemplateConfig } from "../templates";

const defaultTpl: TemplateConfig = {
	language: "zh-CN",
	languageInstruction: "使用简体中文",
	levels: [],
	relatedLinksHeader: "关联连接",
	conflictHeader: "知识冲突",
	originalPrefix: "[原创]",
	pageRules: "",
	analysisSystemPrompt: "",
	editorSystemPrompt: "",
	synthesisEditorPrompt: "",
};

describe("escapeRegex", () => {
	it("escapes regex special characters", () => {
		expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
	});

	it("handles string with no special chars", () => {
		expect(escapeRegex("hello")).toBe("hello");
	});

	it("escapes brackets and pipes", () => {
		expect(escapeRegex("[test]|{val}")).toBe("\\[test\\]\\|\\{val\\}");
	});
});

describe("buildPageIndex", () => {
	it("builds graph with wikilinks", () => {
		const files = [
			{ path: "concepts/核心概念/A.md", content: "See [[B]] and [[C]]." },
		];
		const idx = buildPageIndex(files);
		const links = idx.graph.get("A");
		expect(links).toBeInstanceOf(Set);
		expect(links?.has("B")).toBe(true);
		expect(links?.has("C")).toBe(true);
	});

	it("includes file content in fileMap", () => {
		const files = [
			{ path: "concepts/核心概念/A.md", content: "hello" },
		];
		const idx = buildPageIndex(files);
		expect(idx.fileMap["concepts/核心概念/A.md"]).toBe("hello");
	});

	it("skips index.md and log.md from eligible", () => {
		const files = [
			{ path: "index.md", content: "[[A]]" },
			{ path: "log.md", content: "entry" },
			{ path: "concepts/核心概念/A.md", content: "content" },
		];
		const idx = buildPageIndex(files);
		expect(idx.eligible.length).toBe(1);
	});
});

describe("enrichPageWithLinks", () => {
	it("appends to existing related links section", () => {
		const content = "---\ntitle: Test\n---\n\nContent here.\n\n## 关联连接\n\n- [[ExistingLink]]\n";
		const suggestions: LinkSuggestion[] = [
			{ sourcePage: "A", targetPage: "NewLink", targetDisplay: "NewLink", confidence: 0.8 },
		];
		const result = enrichPageWithLinks(content, suggestions, defaultTpl);
		expect(result).toContain("[[NewLink|NewLink]]");
		expect(result).toContain("[[ExistingLink]]");
	});

	it("creates new section when no related links header exists", () => {
		const content = "---\ntitle: Test\n---\n\nJust content.\n";
		const suggestions: LinkSuggestion[] = [
			{ sourcePage: "A", targetPage: "B", targetDisplay: "B", confidence: 0.7 },
		];
		const result = enrichPageWithLinks(content, suggestions, defaultTpl);
		expect(result).toContain("## 关联连接");
		expect(result).toContain("[[B|B]]");
	});

	it("returns content unchanged when no suggestions", () => {
		const content = "---\ntitle: Test\n---\n\nContent.\n";
		expect(enrichPageWithLinks(content, [], defaultTpl)).toBe(content);
	});
});

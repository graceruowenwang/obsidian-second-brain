import { describe, it, expect } from "vitest";
import { scanBrokenLinks, suggestLevel, sanitizeFilename } from "../compile-gap-detection";
import type { KnowledgeGap } from "../compile-gap-detection";

describe("suggestLevel", () => {
	it("returns 核心概念 when referenced by a core concept path", () => {
		const gap: KnowledgeGap = {
			name: "Test",
			referencedBy: ["concepts/核心概念/Foo.md"],
			referenceCount: 3,
			context: [],
			suggestedLevel: "",
		};
		expect(suggestLevel(gap)).toBe("核心概念");
	});

	it("returns 实践经验 when referenced by practice paths", () => {
		const gap: KnowledgeGap = {
			name: "Test",
			referencedBy: ["concepts/实践经验/Bar.md"],
			referenceCount: 2,
			context: [],
			suggestedLevel: "",
		};
		expect(suggestLevel(gap)).toBe("实践经验");
	});

	it("returns 方法框架 as default", () => {
		const gap: KnowledgeGap = {
			name: "Test",
			referencedBy: ["concepts/方法框架/Baz.md"],
			referenceCount: 2,
			context: [],
			suggestedLevel: "",
		};
		expect(suggestLevel(gap)).toBe("方法框架");
	});

	it("prioritizes 核心概念 over 实践经验", () => {
		const gap: KnowledgeGap = {
			name: "Test",
			referencedBy: ["concepts/实践经验/Bar.md", "concepts/核心概念/Foo.md"],
			referenceCount: 2,
			context: [],
			suggestedLevel: "",
		};
		expect(suggestLevel(gap)).toBe("核心概念");
	});
});

describe("scanBrokenLinks", () => {
	it("returns empty when all links resolve", () => {
		const files = [{ path: "concepts/核心概念/A.md", content: "See [[B]] for details." }];
		const valid = new Set(["B"]);
		expect(scanBrokenLinks(files, valid)).toEqual([]);
	});

	it("detects broken wikilinks", () => {
		const files = [
			{ path: "concepts/核心概念/A.md", content: "See [[MissingConcept]] here.\nAlso [[MissingConcept]] again." },
		];
		const valid = new Set(["A"]);
		const gaps = scanBrokenLinks(files, valid);
		expect(gaps.length).toBe(1);
		expect(gaps[0].name).toBe("MissingConcept");
		expect(gaps[0].referenceCount).toBe(2);
	});

	it("filters out links below MIN_REFERENCE_COUNT", () => {
		const files = [
			{ path: "concepts/核心概念/A.md", content: "See [[OnceOnly]] here." },
		];
		const valid = new Set(["A"]);
		expect(scanBrokenLinks(files, valid)).toEqual([]);
	});

	it("skips index.md and log.md", () => {
		const files = [
			{ path: "index.md", content: "[[Missing]] [[Missing]] [[Missing]]" },
			{ path: "log.md", content: "[[Missing]] [[Missing]] [[Missing]]" },
		];
		const valid = new Set<string>();
		expect(scanBrokenLinks(files, valid)).toEqual([]);
	});

	it("collects context around broken links", () => {
		const files = [
			{ path: "concepts/核心概念/A.md", content: "some text [[MissingConcept]] here\nagain [[MissingConcept]] end" },
		];
		const valid = new Set(["A"]);
		const gaps = scanBrokenLinks(files, valid);
		expect(gaps[0].context.length).toBe(2);
	});
});

describe("sanitizeFilename", () => {
	it("strips unsafe characters", () => {
		expect(sanitizeFilename('file<>:name')).toBe("file___name");
	});

	it("handles empty string", () => {
		expect(sanitizeFilename("")).toBe("_untitled");
	});

	it("handles Windows reserved names", () => {
		expect(sanitizeFilename("CON")).toBe("_CON");
		expect(sanitizeFilename("PRN")).toBe("_PRN");
	});

	it("truncates to 200 characters", () => {
		const long = "a".repeat(300);
		expect(sanitizeFilename(long).length).toBe(200);
	});

	it("trims trailing dots", () => {
		expect(sanitizeFilename("file...")).toBe("file");
	});

	it("passes normal names through", () => {
		expect(sanitizeFilename("NormalName")).toBe("NormalName");
	});
});

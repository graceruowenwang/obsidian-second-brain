import { describe, it, expect } from "vitest";
import { diffFingerprints, simpleHash, computeFingerprint, totalAnalysisCount } from "../file-utils";

describe("simpleHash", () => {
	it("returns consistent hash for same input", () => {
		const h1 = simpleHash("hello world");
		const h2 = simpleHash("hello world");
		expect(h1).toBe(h2);
	});

	it("returns different hash for different input", () => {
		const h1 = simpleHash("hello");
		const h2 = simpleHash("world");
		expect(h1).not.toBe(h2);
	});

	it("handles empty string", () => {
		const h = simpleHash("");
		expect(typeof h).toBe("string");
		expect(h.length).toBeGreaterThan(0);
	});
});

describe("computeFingerprint", () => {
	it("includes content length and hash", () => {
		const fp = computeFingerprint("test content");
		expect(fp.s).toBe("test content".length);
		expect(fp.h).toBe(simpleHash("test content"));
		expect(fp.m).toBeGreaterThan(0);
	});
});

describe("diffFingerprints", () => {
	it("detects new files as changed", () => {
		const cache = { version: 3, fingerprints: {}, analysis: null, pages: {}, analysisTime: null, perFileAnalysis: {}, indexEntries: {}, failedPages: {}, dependencies: {} };
		const files = [{ path: "raw/test.md", content: "hello" }];
		const { changed, unchanged } = diffFingerprints(files, cache as any);
		expect(changed).toHaveLength(1);
		expect(unchanged).toHaveLength(0);
	});

	it("detects modified files", () => {
		const fp = computeFingerprint("old content");
		const cache = { version: 3, fingerprints: { "raw/test.md": fp }, analysis: null, pages: {}, analysisTime: null, perFileAnalysis: {}, indexEntries: {}, failedPages: {}, dependencies: {} };
		const files = [{ path: "raw/test.md", content: "new content" }];
		const { changed } = diffFingerprints(files, cache as any);
		expect(changed).toHaveLength(1);
	});

	it("detects unchanged files", () => {
		const content = "same content";
		const fp = computeFingerprint(content);
		const cache = { version: 3, fingerprints: { "raw/test.md": fp }, analysis: null, pages: {}, analysisTime: null, perFileAnalysis: {}, indexEntries: {}, failedPages: {}, dependencies: {} };
		const files = [{ path: "raw/test.md", content }];
		const { changed, unchanged } = diffFingerprints(files, cache as any);
		expect(changed).toHaveLength(0);
		expect(unchanged).toHaveLength(1);
	});
});

describe("totalAnalysisCount", () => {
	it("returns 0 for null", () => {
		expect(totalAnalysisCount(null)).toBe(0);
	});

	it("sums all categories", () => {
		expect(totalAnalysisCount({
			concepts: [{ name: "A" }, { name: "B" }],
			entities: [{ name: "C" }],
			sources: [{ name: "D" }, { name: "E" }, { name: "F" }],
		})).toBe(6);
	});
});

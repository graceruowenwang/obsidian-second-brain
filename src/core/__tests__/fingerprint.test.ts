import { describe, it, expect } from "vitest";
import { simpleHash, computeFingerprint } from "../fingerprint";

describe("simpleHash (fnv-1a)", () => {
	it("consistent output for same input", () => {
		expect(simpleHash("test")).toBe(simpleHash("test"));
	});

	it("different output for different input", () => {
		expect(simpleHash("abc")).not.toBe(simpleHash("xyz"));
	});

	it("handles empty string", () => {
		expect(typeof simpleHash("")).toBe("string");
	});

	it("handles long content via sampling", () => {
		const long = "a".repeat(10_000);
		const h = simpleHash(long);
		expect(typeof h).toBe("string");
		expect(h.length).toBeGreaterThan(0);
	});

	it("low collision: similar strings produce different hashes", () => {
		const hashes = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			hashes.add(simpleHash(`content-${i}-${Date.now()}`));
		}
		// 1000 unique inputs should produce 1000 unique hashes
		expect(hashes.size).toBe(1000);
	});

	it("distinguishes strings that only differ at the end", () => {
		const base = "a".repeat(1000);
		expect(simpleHash(base + "x")).not.toBe(simpleHash(base + "y"));
	});
});

describe("computeFingerprint", () => {
	it("includes length, hash, and head hash", () => {
		const fp = computeFingerprint("hello world");
		expect(fp.s).toBe(11);
		expect(fp.h).toBeTruthy();
		expect(fp.hh).toBeTruthy();
		expect(fp.m).toBeGreaterThan(0);
	});

	it("different content produces different fingerprints", () => {
		const a = computeFingerprint("aaa");
		const b = computeFingerprint("bbb");
		expect(a.h).not.toBe(b.h);
		expect(a.hh).not.toBe(b.hh);
	});
});

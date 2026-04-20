import { describe, expect, it } from "vitest";
import { extractExecutiveSummary, extractStatus, setWikiFrontmatterStatus, wikiReviewBucket } from "../wiki-shared";

describe("extractExecutiveSummary", () => {
	it("parses quoted JSON-style value", () => {
		const fm = `---
title: Test
executive_summary: "First point. Second point."
---
# Hello
`;
		expect(extractExecutiveSummary(fm)).toBe("First point. Second point.");
	});

	it("parses escaped quotes inside summary", () => {
		const fm = `---
executive_summary: "He said \\"hello\\" here."
---
`;
		expect(extractExecutiveSummary(fm)).toBe('He said "hello" here.');
	});

	it("returns empty when missing", () => {
		expect(extractExecutiveSummary("---\ntitle: x\n---\n")).toBe("");
	});
});

describe("extractStatus / CRLF", () => {
	it("reads status from CRLF frontmatter", () => {
		const c = "---\r\nstatus: \"reviewed\"\r\ntitle: T\r\n---\r\nbody";
		expect(extractStatus(c)).toBe("reviewed");
	});
});

describe("wikiReviewBucket", () => {
	const fm = (status: string) => `---\ntitle: T\n${status ? `status: ${status}\n` : ""}---\n`;

	it("classifies reviewed", () => {
		expect(wikiReviewBucket(fm('"reviewed"'))).toBe("reviewed");
	});

	it("classifies draft and missing status as pending", () => {
		expect(wikiReviewBucket(fm('"draft"'))).toBe("pending");
		expect(wikiReviewBucket(fm(""))).toBe("pending");
	});

	it("classifies gap and outdated as other", () => {
		expect(wikiReviewBucket(fm('"gap"'))).toBe("other");
		expect(wikiReviewBucket(fm('"outdated"'))).toBe("other");
	});
});

describe("setWikiFrontmatterStatus", () => {
	it("inserts status when frontmatter has no status line", () => {
		const o = "---\ntitle: A\ntype: concept\n---\n\nhi";
		const r = setWikiFrontmatterStatus(o, "reviewed");
		expect(r).toContain("status: \"reviewed\"");
		expect(r).toContain("title: A");
	});

	it("replaces existing status including quoted values", () => {
		const o = "---\ntitle: A\nstatus: \"outdated\"\n---\n\nx";
		const r = setWikiFrontmatterStatus(o, "reviewed");
		expect(r).toMatch(/status: "reviewed"/);
		expect(r).not.toContain("outdated");
	});

	it("prepends frontmatter when file has none", () => {
		expect(setWikiFrontmatterStatus("# only", "draft")).toMatch(/^---\nstatus: "draft"/);
	});
});

import { describe, expect, it } from "vitest";
import {
	type WikiPage,
	countIndexUnresolvedLinks,
	extractExecutiveSummary,
	extractStatus,
	parseWikiIndexListItem,
	resolveWikiPageByName,
	resolveWikiPageTarget,
	setWikiFrontmatterStatus,
	wikiReviewBucket,
	wikiStatusNorm,
	type IndexSection,
} from "../wiki-shared";

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

	it("treats capitalized draft and explicit pending as pending queue", () => {
		expect(wikiReviewBucket(fm("Draft"))).toBe("pending");
		expect(wikiReviewBucket(fm('"pending"'))).toBe("pending");
		expect(wikiStatusNorm(fm("Draft"))).toBe("draft");
	});

	it("classifies gap and outdated as other", () => {
		expect(wikiReviewBucket(fm('"gap"'))).toBe("other");
		expect(wikiReviewBucket(fm('"outdated"'))).toBe("other");
	});
});

describe("resolveWikiPageByName / resolveWikiPageTarget", () => {
	const pages: WikiPage[] = [
		{ path: "concepts/Foo-Bar.md", content: "" },
		{ path: "entities/Baz.md", content: "" },
	];

	it("matches .md suffix and #heading in link name", () => {
		expect(resolveWikiPageByName("Foo-Bar.md", pages)?.path).toBe("concepts/Foo-Bar.md");
		expect(resolveWikiPageByName("Foo-Bar#sec", pages)?.path).toBe("concepts/Foo-Bar.md");
	});

	it("matches path-style key", () => {
		expect(resolveWikiPageByName("concepts/Foo-Bar", pages)?.path).toBe("concepts/Foo-Bar.md");
	});

	it("resolves exact wiki path for batch targets", () => {
		expect(resolveWikiPageTarget("entities/Baz.md", pages)?.path).toBe("entities/Baz.md");
	});

	it("falls back to case-insensitive basename", () => {
		const p: WikiPage[] = [{ path: "concepts/UPPER.md", content: "" }];
		expect(resolveWikiPageByName("upper", p)?.path).toBe("concepts/UPPER.md");
	});
});

describe("parseWikiIndexListItem", () => {
	it("parses wikilink with em dash or hyphen before desc", () => {
		expect(parseWikiIndexListItem("- [[Foo|Bar]] — note")).toEqual({ name: "Foo", display: "Bar", desc: "note" });
		expect(parseWikiIndexListItem("-  [[Foo]] - short")).toEqual({ name: "Foo", display: "Foo", desc: "short" });
	});

	it("parses markdown link and basename from path", () => {
		expect(parseWikiIndexListItem("- [Label](concepts/My-Page.md)")).toEqual({
			name: "My-Page",
			display: "Label",
			desc: "",
		});
	});

	it("parses plain title — description", () => {
		expect(parseWikiIndexListItem("- **Bold** — body here")).toEqual({
			name: "Bold",
			display: "Bold",
			desc: "body here",
		});
		expect(parseWikiIndexListItem("- Title -- double hyphen desc")).toEqual({
			name: "Title",
			display: "Title",
			desc: "double hyphen desc",
		});
	});

	it("returns null for non-list lines", () => {
		expect(parseWikiIndexListItem("## Section")).toBeNull();
		expect(parseWikiIndexListItem("- [broken only")).toBeNull();
	});
});

describe("countIndexUnresolvedLinks with mixed index formats", () => {
	const pages: WikiPage[] = [{ path: "concepts/Real.md", content: "" }];
	const indexData: IndexSection[] = [
		{
			title: "T",
			subs: [
				{
					title: "",
					items: [
						{ name: "Real", display: "Real", desc: "" },
						{ name: "Ghost", display: "Ghost", desc: "" },
						parseWikiIndexListItem("- [x](concepts/Real.md)")!,
					],
				},
			],
		},
	];

	it("counts unresolved once per distinct name", () => {
		expect(countIndexUnresolvedLinks(indexData, pages)).toBe(1);
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

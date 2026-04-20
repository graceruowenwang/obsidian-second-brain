import { describe, it, expect } from "vitest";
import { diffAnalysis } from "../compile-pages";
import type { Analysis } from "../../types";

function analysis(over: Partial<Analysis> = {}): Analysis {
	return {
		concepts: [],
		entities: [],
		sources: [],
		syntheses: [],
		...over,
	};
}

describe("diffAnalysis", () => {
	it("oldAnalysis 为 null 时全部进入 regen", () => {
		const newA = analysis({
			concepts: [{
				name: "Alpha",
				title: "Alpha",
				level: "方法框架",
				desc: "",
				source_file: "raw/x.md",
			}],
		});
		const r = diffAnalysis(null, newA, [], {});
		expect(r.regen).toHaveLength(1);
		expect(r.regen[0].name).toBe("Alpha");
		expect(r.skip).toHaveLength(0);
		expect(r.remove).toHaveLength(0);
	});

	it("字段完全一致且未受影响时 skip", () => {
		const c = {
			name: "Beta",
			title: "Beta",
			level: "方法框架",
			desc: "same",
			source_file: "raw/b.md",
		};
		const oldA = analysis({ concepts: [c] });
		const newA = analysis({ concepts: [{ ...c }] });
		const r = diffAnalysis(oldA, newA, [], {});
		expect(r.skip.some((x) => x.name === "Beta")).toBe(true);
		expect(r.regen.filter((x) => x.name === "Beta")).toHaveLength(0);
	});

	it("desc 变化时进入 regen", () => {
		const c = {
			name: "Gamma",
			title: "Gamma",
			level: "方法框架",
			desc: "v1",
			source_file: "raw/g.md",
		};
		const oldA = analysis({ concepts: [c] });
		const newA = analysis({ concepts: [{ ...c, desc: "v2" }] });
		const r = diffAnalysis(oldA, newA, [], {});
		expect(r.regen.some((x) => x.name === "Gamma")).toBe(true);
	});

	it("新分析中删除的项进入 remove", () => {
		const c = {
			name: "Rm",
			title: "Rm",
			level: "方法框架",
			desc: "",
			source_file: "raw/r.md",
		};
		const oldA = analysis({ concepts: [c] });
		const newA = analysis({ concepts: [] });
		const r = diffAnalysis(oldA, newA, [], {});
		expect(r.remove).toHaveLength(1);
		expect(r.remove[0].name).toBe("Rm");
	});

	it("依赖图中 raw 变更传递至页面时 regen", () => {
		const c = {
			name: "Dep",
			title: "Dep",
			level: "方法框架",
			desc: "d",
			source_file: "raw/unaffected.md",
		};
		const oldA = analysis({ concepts: [c] });
		const newA = analysis({ concepts: [{ ...c }] });
		const pagePath = "concepts/方法框架/Dep.md";
		// dependencies: 页面路径 → 该页依赖的 raw 路径列表（见 findAffectedPages 反向索引）
		const deps: Record<string, string[]> = {
			[pagePath]: ["raw/other.md"],
		};
		const changed = [{ path: "raw/other.md", content: "touch" }];
		const r = diffAnalysis(oldA, newA, changed, deps);
		expect(r.regen.some((x) => x.name === "Dep")).toBe(true);
	});
});

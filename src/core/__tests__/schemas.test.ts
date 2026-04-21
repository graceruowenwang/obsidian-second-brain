import { describe, it, expect } from "vitest";
import {
	ConceptSchema, EntitySchema, SourceSchema, SynthesisSchema,
	parseAnalysisPartial,
} from "../schemas";

describe("ConceptSchema", () => {
	it("trims name and defaults title to name", () => {
		const result = ConceptSchema.parse({ name: " TestConcept " });
		expect(result.name).toBe("TestConcept");
		expect(result.title).toBe("TestConcept");
	});

	it("uses explicit title over name", () => {
		const result = ConceptSchema.parse({ name: "Foo", title: "Foo Display" });
		expect(result.title).toBe("Foo Display");
	});

	it("rejects empty name", () => {
		expect(ConceptSchema.safeParse({ name: "" }).success).toBe(false);
	});
});

describe("SynthesisSchema", () => {
	it("filters out syntheses with fewer than 2 concepts", () => {
		const result = SynthesisSchema.parse({ name: "Test", concepts: ["A"] });
		expect(result.concepts).toEqual([]);
	});

	it("keeps syntheses with 2+ concepts", () => {
		const result = SynthesisSchema.parse({ name: "Test", concepts: ["A", "B"] });
		expect(result.concepts).toEqual(["A", "B"]);
	});
});

describe("EntitySchema", () => {
	it("trims name", () => {
		expect(EntitySchema.parse({ name: " Entity " }).name).toBe("Entity");
	});

	it("defaults desc to empty string", () => {
		expect(EntitySchema.parse({ name: "X" }).desc).toBe("");
	});
});

describe("SourceSchema", () => {
	it("trims name and defaults fields", () => {
		const result = SourceSchema.parse({ name: " Source " });
		expect(result.name).toBe("Source");
		expect(result.source_file).toBe("");
		expect(result.desc).toBe("");
	});
});

describe("parseAnalysisPartial", () => {
	it("returns error for non-object input", () => {
		const result = parseAnalysisPartial("not an object");
		expect(result.issues.length).toBe(1);
		expect(result.issues[0].severity).toBe("error");
		expect(result.concepts).toEqual([]);
	});

	it("parses valid concepts", () => {
		const result = parseAnalysisPartial({
			concepts: [{ name: "ConceptA", title: "Display A", level: "核心概念", desc: "A concept" }],
		});
		expect(result.concepts.length).toBe(1);
		expect(result.concepts[0].name).toBe("ConceptA");
	});

	it("skips invalid concepts and records issues", () => {
		const result = parseAnalysisPartial({
			concepts: [{ name: "Valid" }, { name: "" }],
		});
		expect(result.concepts.length).toBe(1);
		expect(result.issues.length).toBe(1);
	});

	it("handles all four field types", () => {
		const result = parseAnalysisPartial({
			concepts: [{ name: "C1" }],
			entities: [{ name: "E1" }],
			sources: [{ name: "S1" }],
			syntheses: [{ name: "Syn1", concepts: ["C1", "C2"] }],
		});
		expect(result.concepts.length).toBe(1);
		expect(result.entities.length).toBe(1);
		expect(result.sources.length).toBe(1);
		expect(result.syntheses.length).toBe(1);
	});

	it("returns empty arrays for missing fields", () => {
		const result = parseAnalysisPartial({});
		expect(result.concepts).toEqual([]);
		expect(result.entities).toEqual([]);
		expect(result.sources).toEqual([]);
		expect(result.syntheses).toEqual([]);
	});
});

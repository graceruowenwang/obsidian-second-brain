import { describe, it, expect } from "vitest";
import {
	parseEmbeddingResponseBody,
	normalizeEmbeddingBaseUrl,
	embeddingMetaForSettings,
} from "../file-utils";
import { DEFAULT_SETTINGS } from "../../types";

describe("normalizeEmbeddingBaseUrl", () => {
	it("strips trailing slashes", () => {
		expect(normalizeEmbeddingBaseUrl("https://api.openai.com/v1///")).toBe("https://api.openai.com/v1");
	});
});

describe("embeddingMetaForSettings", () => {
	it("combines normalized baseUrl, model and dim", () => {
		const s = { ...DEFAULT_SETTINGS, embeddingBaseUrl: "https://x.com/v1/", embeddingModel: "m" };
		expect(embeddingMetaForSettings(s, 3)).toEqual({
			baseUrl: "https://x.com/v1",
			model: "m",
			dim: 3,
		});
	});
});

describe("parseEmbeddingResponseBody", () => {
	it("extracts first embedding vector", () => {
		const v = [0.1, 0.2, -0.3];
		expect(parseEmbeddingResponseBody({ data: [{ embedding: v }] })).toEqual(v);
	});

	it("throws on missing data", () => {
		expect(() => parseEmbeddingResponseBody({})).toThrow(/无 data/);
	});

	it("throws on invalid embedding", () => {
		expect(() => parseEmbeddingResponseBody({ data: [{ embedding: "x" }] })).toThrow(/无有效 embedding/);
	});
});

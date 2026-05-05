import { describe, it, expect, vi, beforeEach } from "vitest";
import { callLLMBatch } from "../llm";

// Mock requestUrl to avoid real network calls
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

describe("callLLMBatch", () => {
	const settings = {
		provider: "openai" as const,
		baseUrl: "https://api.test.com/v1",
		apiKey: "test-key",
		model: "test-model",
		temperature: 0.5,
		maxTokens: 100,
		useStreaming: false,
		embeddingBaseUrl: "",
		embeddingModel: "",
		embeddingApiKey: "",
	} as any;

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("handles empty task list", async () => {
		const results = await callLLMBatch([], settings);
		expect(results).toHaveLength(0);
	});

	it("cancels remaining tasks on abort signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const tasks = [
			{ messages: [{ role: "user", content: "test" }], options: {} },
			{ messages: [{ role: "user", content: "test2" }], options: {} },
		];
		const results = await callLLMBatch(tasks, settings, { signal: controller.signal });
		expect(results.every(r => r.status === "rejected")).toBe(true);
	});

	it("returns results indexed correctly", async () => {
		// requestUrl mock returns a valid OpenAI response
		const { requestUrl } = await import("obsidian");
		(requestUrl as ReturnType<typeof vi.fn>).mockResolvedValue({
			status: 200,
			json: { choices: [{ message: { content: "response" } }] },
		});

		const tasks = [
			{ messages: [{ role: "user", content: "a" }], options: {} },
			{ messages: [{ role: "user", content: "b" }], options: {} },
		];
		const results = await callLLMBatch(tasks, settings, { concurrency: 2, batchDelay: 0 });
		expect(results).toHaveLength(2);
		expect(results[0].index).toBe(0);
		expect(results[1].index).toBe(1);
	});

	it("handles partial failures gracefully", async () => {
		const { requestUrl } = await import("obsidian");
		(requestUrl as ReturnType<typeof vi.fn>)
			.mockResolvedValueOnce({
				status: 200,
				json: { choices: [{ message: { content: "ok" } }] },
			})
			.mockRejectedValueOnce(new Error("network fail"));

		const tasks = [
			{ messages: [{ role: "user", content: "a" }], options: {} },
			{ messages: [{ role: "user", content: "b" }], options: {} },
		];
		const results = await callLLMBatch(tasks, settings, { concurrency: 1, batchDelay: 0, perItemRetry: 0 });
		const fulfilled = results.filter(r => r.status === "fulfilled");
		const rejected = results.filter(r => r.status === "rejected");
		expect(fulfilled.length + rejected.length).toBe(2);
	});
});

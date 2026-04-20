import { describe, it, expect } from "vitest";
import { extractWebhookEventTimeMs, isWebhookEventTooOld } from "./webhook-guards.js";

describe("webhook-guards", () => {
	it("extractWebhookEventTimeMs 支持秒与毫秒", () => {
		expect(extractWebhookEventTimeMs({ created: 1700000000 })).toBe(1700000000000);
		expect(extractWebhookEventTimeMs({ data: { paid_at: 1700000000000 } })).toBe(1700000000000);
	});

	it("无时间字段时不视为过期", () => {
		expect(isWebhookEventTooOld({ type: "charge_succeeded", data: {} }, Date.now(), 60_000)).toBe(false);
	});

	it("超过窗口视为过期", () => {
		const old = Date.now() - 20 * 60 * 1000;
		expect(isWebhookEventTooOld({ data: { paid_at: old } }, Date.now(), 15 * 60 * 1000)).toBe(true);
	});
});

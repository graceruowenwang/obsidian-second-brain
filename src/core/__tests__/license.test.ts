import { describe, it, expect } from "vitest";
import { needsRevalidation } from "../license";
import type { LicenseInfo } from "../../types";

function make(overrides: Partial<LicenseInfo> = {}): LicenseInfo {
	return {
		key: "X",
		status: "active",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: null,
		trialStart: null,
		instanceId: null,
		freeChatUsed: 0,
		freeChatMonth: "",
		...overrides,
	};
}

describe("needsRevalidation", () => {
	it("free plan 永不需要 revalidate", () => {
		expect(needsRevalidation(make({ plan: "free" }))).toBe(false);
	});

	it("pro 且从未验证过 → 需要", () => {
		expect(needsRevalidation(make({ lastValidated: null }))).toBe(true);
	});

	it("pro 且最近验证过 → 不需要", () => {
		expect(needsRevalidation(make())).toBe(false);
	});

	it("pro 且 lastValidated 超过 7 天 → 需要", () => {
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		expect(needsRevalidation(make({ lastValidated: old }))).toBe(true);
	});

	it("lastValidated 是非法字符串 → 保守返回 true（需要重新验证）", () => {
		expect(needsRevalidation(make({ lastValidated: "not-a-date" }))).toBe(true);
	});
});

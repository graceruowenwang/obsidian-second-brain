import { describe, it, expect } from "vitest";
import { needsRevalidation, shouldStartCompileTrial } from "../license";
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
		trialExpiredShown: false,
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

describe("shouldStartCompileTrial", () => {
	it("已填激活码 → 不启动", () => {
		expect(shouldStartCompileTrial(make({ status: "none", plan: "free" }), "ABC-123")).toBe(false);
	});

	it("已付费 active → 不启动", () => {
		expect(shouldStartCompileTrial(make({ status: "active", plan: "pro" }), "")).toBe(false);
	});

	it("grace 迁移窗口 → 不启动", () => {
		expect(
			shouldStartCompileTrial(
				make({ status: "grace", plan: "pro", graceStart: new Date().toISOString() }),
				"",
			),
		).toBe(false);
	});

	it("已在 trial 且已有 trialStart → 不启动", () => {
		expect(
			shouldStartCompileTrial(
				make({
					status: "trial",
					plan: "pro",
					trialStart: new Date().toISOString(),
				}),
				"",
			),
		).toBe(false);
	});

	it("无 key、无试用记录 → 启动（含公测 BETA_MODE 场景）", () => {
		expect(shouldStartCompileTrial(make({ status: "none", plan: "free", trialStart: null }), "")).toBe(true);
		expect(shouldStartCompileTrial(make({ status: "trial", plan: "pro", trialStart: null }), "  ")).toBe(true);
	});
});

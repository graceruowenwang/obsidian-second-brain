// License 验证模块 — LemonSqueezy License Key 验证

import { requestUrl } from "obsidian";
import type { LicenseInfo } from "../types";
import { DEFAULT_LICENSE } from "../types";

const LEMON_API = "https://api.lemonsqueezy.com/v1/licenses";
const VALIDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 天
const GRACE_PERIOD = 14 * 24 * 60 * 60 * 1000; // 14 天
const TRIAL_PERIOD = 3 * 24 * 60 * 60 * 1000; // 3 天
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 小时
const MAX_ATTEMPTS_PER_HOUR = 5;

let attemptTimestamps: number[] = [];

function checkRateLimit(): boolean {
	const now = Date.now();
	attemptTimestamps = attemptTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
	if (attemptTimestamps.length >= MAX_ATTEMPTS_PER_HOUR) return false;
	attemptTimestamps.push(now);
	return true;
}

export async function validateLicense(key: string): Promise<LicenseInfo> {
	if (!checkRateLimit()) {
		throw new Error("Rate limit exceeded. Please try again later.");
	}

	try {
		const resp = await requestUrl({
			url: `${LEMON_API}/validate`,
			method: "POST",
			headers: { "Content-Type": "application/json", "Accept": "application/json" },
			body: JSON.stringify({ license_key: key }),
		});

		const data = resp.json;
		const valid = data?.valid === true;
		const status = data?.license_key?.status || "inactive";
		const expiresAt = data?.license_key?.expires_at || null;

		if (valid && status === "active") {
			return {
				key,
				status: "active",
				plan: "pro",
				expiresAt,
				lastValidated: new Date().toISOString(),
				graceStart: null,
				trialStart: null,
				freeChatUsed: 0,
				freeChatMonth: "",
			};
		}

		if (status === "expired") {
			return { ...DEFAULT_LICENSE, key, status: "expired", plan: "free" };
		}

		return { ...DEFAULT_LICENSE, key, status: "inactive", plan: "free" };
	} catch (e: unknown) {
		// 网络错误 — 不改变 plan，进入宽限期
		throw e;
	}
}

export async function deactivateLicense(key: string): Promise<void> {
	try {
		await requestUrl({
			url: `${LEMON_API}/deactivate`,
			method: "POST",
			headers: { "Content-Type": "application/json", "Accept": "application/json" },
			body: JSON.stringify({ license_key: key }),
		});
	} catch (e) {
		console.warn("license: deactivate failed:", e);
		// 即使 deactivate API 失败也继续清理本地状态
	}
}

export function isPro(state: LicenseInfo): boolean {
	if (state.plan !== "pro") return false;
	if (state.status === "active") return true;
	if (state.status === "trial") {
		if (!state.trialStart) return false;
		return Date.now() - new Date(state.trialStart).getTime() < TRIAL_PERIOD;
	}
	if (state.status === "grace") {
		if (!state.graceStart) return false;
		return Date.now() - new Date(state.graceStart).getTime() < GRACE_PERIOD;
	}
	return false;
}

export function needsRevalidation(state: LicenseInfo): boolean {
	if (!state.key || state.status === "none") return false;
	if (!state.lastValidated) return true;
	return Date.now() - new Date(state.lastValidated).getTime() > VALIDATE_INTERVAL;
}

export function enterGraceIfNeeded(state: LicenseInfo): LicenseInfo {
	if (state.plan !== "pro") return state;
	if (state.status === "active" || state.status === "grace") {
		return { ...state, status: "grace", graceStart: state.graceStart || new Date().toISOString() };
	}
	return state;
}

export function checkGraceExpiry(state: LicenseInfo): LicenseInfo {
	if (state.status !== "grace" || !state.graceStart) return state;
	if (Date.now() - new Date(state.graceStart).getTime() >= GRACE_PERIOD) {
		return { ...DEFAULT_LICENSE, key: state.key };
	}
	return state;
}

export function getDefaultLicense(): LicenseInfo {
	return { ...DEFAULT_LICENSE };
}

export function getTrialLicense(): LicenseInfo {
	return {
		key: "",
		status: "grace",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: new Date().toISOString(),
		trialStart: null,
	};
}

export function getCompileTrialLicense(): LicenseInfo {
	return {
		key: "",
		status: "trial",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: null,
		trialStart: new Date().toISOString(),
	};
}

export function isTrialActive(state: LicenseInfo): boolean {
	return state.status === "trial" && isPro(state);
}

export function getTrialDaysLeft(state: LicenseInfo): number {
	if (!state.trialStart) return 0;
	const elapsed = Date.now() - new Date(state.trialStart).getTime();
	const remaining = TRIAL_PERIOD - elapsed;
	return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

export function checkTrialExpiry(state: LicenseInfo): LicenseInfo {
	if (state.status !== "trial" || !state.trialStart) return state;
	if (Date.now() - new Date(state.trialStart).getTime() >= TRIAL_PERIOD) {
		return { ...DEFAULT_LICENSE };
	}
	return state;
}

// Freemium Chat — 每月 3 条免费消息
const FREE_CHAT_MONTHLY_LIMIT = 3;

export function checkFreeChatQuota(state: LicenseInfo): { allowed: boolean; used: number; limit: number; remaining: number } {
	if (isPro(state)) return { allowed: true, used: 0, limit: Infinity, remaining: Infinity };
	const now = new Date();
	const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	if (state.freeChatMonth !== currentMonth) {
		return { allowed: true, used: 0, limit: FREE_CHAT_MONTHLY_LIMIT, remaining: FREE_CHAT_MONTHLY_LIMIT };
	}
	const remaining = FREE_CHAT_MONTHLY_LIMIT - state.freeChatUsed;
	return { allowed: remaining > 0, used: state.freeChatUsed, limit: FREE_CHAT_MONTHLY_LIMIT, remaining: Math.max(0, remaining) };
}

export function incrementFreeChatUsage(state: LicenseInfo): LicenseInfo {
	const now = new Date();
	const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
	if (state.freeChatMonth !== currentMonth) {
		return { ...state, freeChatMonth: currentMonth, freeChatUsed: 1 };
	}
	return { ...state, freeChatUsed: state.freeChatUsed + 1 };
}

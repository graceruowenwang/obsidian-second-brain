// License 验证模块 — LemonSqueezy License Key 验证

import { requestUrl } from "obsidian";
import type { LicenseInfo } from "../types";
import { DEFAULT_LICENSE } from "../types";

const LEMON_API = "https://api.lemonsqueezy.com/v1/licenses";
const VALIDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const GRACE_PERIOD = 14 * 24 * 60 * 60 * 1000;
const TRIAL_PERIOD = 3 * 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_HOUR = 5;

let attemptTimestamps: number[] = [];

function checkRateLimit(): boolean {
	const now = Date.now();
	attemptTimestamps = attemptTimestamps.filter(ts => now - ts < RATE_LIMIT_WINDOW);
	if (attemptTimestamps.length >= MAX_ATTEMPTS_PER_HOUR) return false;
	attemptTimestamps.push(now);
	return true;
}

function formEncode(data: Record<string, string>): string {
	return Object.entries(data)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

function getInstanceName(): string {
	// 用 vault 路径的 hash 作为 instance 标识
	return "obsidian-second-brain";
}

// 激活 License（首次输入 key 时调用）
export async function activateLicense(key: string): Promise<LicenseInfo> {
	if (!checkRateLimit()) {
		throw new Error("Rate limit exceeded. Please try again later.");
	}

	try {
		const resp = await requestUrl({
			url: `${LEMON_API}/activate`,
			method: "POST",
			headers: { "Accept": "application/json" },
			body: formEncode({ license_key: key, instance_name: getInstanceName() }),
		});

		const data = resp.json;
		const activated = data?.activated === true;
		const status = data?.license_key?.status || "inactive";
		const expiresAt = data?.license_key?.expires_at || null;
		const instanceId = data?.instance?.id || null;

		if (activated && status === "active") {
			return {
				key,
				status: "active",
				plan: "pro",
				expiresAt,
				lastValidated: new Date().toISOString(),
				graceStart: null,
				trialStart: null,
				instanceId,
				freeChatUsed: 0,
				freeChatMonth: "",
			};
		}

		if (status === "expired") {
			return { ...DEFAULT_LICENSE, key, status: "expired" };
		}

		return { ...DEFAULT_LICENSE, key, status: "inactive" };
	} catch (e: unknown) {
		throw e;
	}
}

// 验证 License（定期后台调用）
export async function validateLicense(key: string, instanceId?: string | null): Promise<LicenseInfo> {
	if (!checkRateLimit()) {
		throw new Error("Rate limit exceeded. Please try again later.");
	}

	try {
		const params: Record<string, string> = { license_key: key };
		if (instanceId) params.instance_id = instanceId;

		const resp = await requestUrl({
			url: `${LEMON_API}/validate`,
			method: "POST",
			headers: { "Accept": "application/json" },
			body: formEncode(params),
		});

		const data = resp.json;
		const valid = data?.valid === true;
		const status = data?.license_key?.status || "inactive";
		const expiresAt = data?.license_key?.expires_at || null;
		const respInstanceId = data?.instance?.id || instanceId || null;

		if (valid && status === "active") {
			return {
				key,
				status: "active",
				plan: "pro",
				expiresAt,
				lastValidated: new Date().toISOString(),
				graceStart: null,
				trialStart: null,
				instanceId: respInstanceId,
				freeChatUsed: 0,
				freeChatMonth: "",
			};
		}

		if (status === "expired") {
			return { ...DEFAULT_LICENSE, key, status: "expired", instanceId: respInstanceId };
		}

		return { ...DEFAULT_LICENSE, key, status: "inactive", instanceId: respInstanceId };
	} catch (e: unknown) {
		throw e;
	}
}

// 停用 License（用户主动停用或切换设备）
export async function deactivateLicense(key: string, instanceId: string | null): Promise<void> {
	if (!instanceId) return;
	try {
		await requestUrl({
			url: `${LEMON_API}/deactivate`,
			method: "POST",
			headers: { "Accept": "application/json" },
			body: formEncode({ license_key: key, instance_id: instanceId }),
		});
	} catch (e) {
		console.warn("license: deactivate failed:", e);
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
		instanceId: null,
		freeChatUsed: 0,
		freeChatMonth: "",
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
		instanceId: null,
		freeChatUsed: 0,
		freeChatMonth: "",
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

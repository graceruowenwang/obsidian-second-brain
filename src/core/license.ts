// License 验证模块 — 离线哈希验证 + 爱发电订单号在线激活

import type { LicenseInfo } from "../types";
import { DEFAULT_LICENSE } from "../types";

// Cloudflare Worker 地址（部署后替换）
const WORKER_URL = "https://sb-license.graceruowenwang.workers.dev";

// 预生成的 license key SHA256 哈希（离线验证用）
const VALID_HASHES = new Set([
	"02d3c775d1e8afec5de80b745227276fb68e36566b9294aecbfd72f1b9c59deb",
	"ae3218bdbd83337270d04262dff4eb4d88d91cae4f62578b9ecb4f8e08d9ae4e",
	"add873c934d84f9efe06e182509fe0f101e28da2fda01c5348304726d6088a8a",
	"fd83964ab733081e65b26d6afb1ad86d7eaf6dccda5cd2f5e98e81be438b42e2",
	"052c00ccca6cfc6f1c1620a5f67d39520c903c467c509f5b1bb0b923953b5b18",
	"18bda8c400c960eafab60925462e4a0dac251029c895068ec80a15d23f68e9ab",
	"63d367a95ffd1f2cd4c3e92915ba6346f33ed04bfcc927c8f2a253ab7e2f2603",
	"182a814ddfdd0b9de71261bd2a7345c91889cc117a5ff47cf098a76cf623bc9a",
	"2b35cd49317d1545d9dce4daa4ef9803ff8f16499acffbb08a4816ef8335bccf",
	"5849d016a99bd869c812435d8223fe30dbd7d46c13dd017d225c08f6aace8a76",
	"30459929954edbf083853160402f16068d744f1e58f62bc85dd9b74e2039c662",
	"3ee0e53a603934911e1b4bc6dee26c2339a35b5d492dd1dc1df0a5f1c9fb968d",
	"25b20d184f46f6118f120788bad6976ef344169f86d734e17db6c722ecf64639",
	"dea05d293600562928ef691716ab80a1b2927f1d79d9f871f917397efa7c2773",
	"acd413d64897740711d6c31b1e76c8d7c3b19d16b602294c412ceef1b37c8a61",
	"8507409bb36f3f232a40513d6a5697f24948fc994290c4e2a84fd5e45134a0fa",
	"3497cf73e02221d86ce900aad465812c94ea53d090466b83152b196b74aa6125",
	"68a2c07107f408a55d797f9ef08e29cbca8724001c9b15b9d9f5fae0ff26fd4a",
	"730ccf1f9c46535efdfa9ddcdc49bd46faff51a4f5842ddf154c9e8366aec526",
	"c97d8e98854c8957b4cd2469c54e93a234b09ce3408608e7ba2e33026c89fc11",
]);

const GRACE_PERIOD = 14 * 24 * 60 * 60 * 1000;
const TRIAL_PERIOD = 14 * 24 * 60 * 60 * 1000;
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

async function sha256(text: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(text);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// 通过爱发电订单号在线激活：调用 Cloudflare Worker 验证订单
export async function activateByOrder(orderId: string, instanceName: string): Promise<{ licenseInfo: LicenseInfo; licenseKey: string }> {
	if (!checkRateLimit()) {
		throw new Error("Rate limit exceeded. Please try again later.");
	}

	const resp = await fetch(`${WORKER_URL}/activate-order`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ order_id: orderId, instance_name: instanceName }),
	});

	const data = await resp.json() as { activated?: boolean; license_key?: string; error?: string };

	if (!data.activated || !data.license_key) {
		throw new Error(data.error || "Activation failed");
	}

	const licenseInfo: LicenseInfo = {
		key: data.license_key,
		status: "active",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: null,
		trialStart: null,
		instanceId: instanceName,
		freeChatUsed: 0,
		freeChatMonth: "",
	};

	return { licenseInfo, licenseKey: data.license_key };
}

// 离线激活：验证 key 哈希是否在预置列表中
export async function activateLicense(key: string): Promise<LicenseInfo> {
	if (!checkRateLimit()) {
		throw new Error("Rate limit exceeded. Please try again later.");
	}

	const trimmed = key.trim().toUpperCase();
	const hash = await sha256(trimmed);

	if (!VALID_HASHES.has(hash)) {
		return { ...DEFAULT_LICENSE, key: trimmed, status: "invalid" };
	}

	return {
		key: trimmed,
		status: "active",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: null,
		trialStart: null,
		instanceId: null,
		freeChatUsed: 0,
		freeChatMonth: "",
	};
}

// 离线验证：重新检查 key
export async function validateLicense(_key: string, _instanceId?: string | null): Promise<LicenseInfo> {
	if (!checkRateLimit()) {
		throw new Error("Rate limit exceeded. Please try again later.");
	}

	const trimmed = _key.trim().toUpperCase();
	const hash = await sha256(trimmed);

	if (!VALID_HASHES.has(hash)) {
		return { ...DEFAULT_LICENSE, key: trimmed, status: "invalid" };
	}

	return {
		key: trimmed,
		status: "active",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: null,
		trialStart: null,
		instanceId: _instanceId || null,
		freeChatUsed: 0,
		freeChatMonth: "",
	};
}

// 停用（离线，仅清除本地状态）
export async function deactivateLicense(_key: string, _instanceId: string | null): Promise<void> {
	// 离线模式无需服务端调用
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

export function needsRevalidation(_state: LicenseInfo): boolean {
	// 离线模式不需要后台重新验证
	return false;
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

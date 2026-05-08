// License 验证模块 — 在线 (Gumroad API) + 离线 (SHA256 哈希) 双重验证

import type { LicenseInfo } from "../types";
import { requestUrl } from "obsidian";
import { DEFAULT_LICENSE } from "../types";

// === Beta 阶段开关 ===
// true  : 所有 Pro 功能免费使用、免费聊天无限额度（适用于面包多审核期间 / 早鸟阶段）
// false : 正式付费模式（恢复原有激活码 + 试用期 + 每月免费额度的完整逻辑）
//
// 公测对外说明：首次编译成功后会进入 TRIAL_PERIOD_DAYS 天完整 Pro 试用（见 getCompileTrialLicense）。
// 切换到 false 后用户无感知升级：已激活 Pro 的继续 Pro，未激活的回到 Free 档 + 上述试用。
// BETA_MODE 仅改这一行然后重新发布即可。
export const BETA_MODE = false;

/** 完整 Pro 试用天数（与对外「公测 14 天完整试用」一致；门控以 TRIAL_PERIOD 为准） */
export const TRIAL_PERIOD_DAYS = 14;

const GUMROAD_PRODUCT_ID = "DNhBwrQ0DnDLWnieY-oaRg==";
const GUMROAD_VERIFY_URL = "https://api.gumroad.com/v2/licenses/verify";

// 预生成的 license key SHA256 哈希（离线验证用）
const VALID_HASHES = new Set([
	"f1b032dd5ab180c0b6eef75fd944162e66aadfec6c9a126b32cfceed2cd03e9b",
	"2ae81061682bd52ac93b7980ab9a71073e6b3d2666088a8dc8736b7b1d1b3ad1",
	"dc936f8b4a039ae1034b18b2f5d3baacec6ec804435a1d639e89a72dfa3f270f",
	"e5afedf29248ba42d813be01718615dbfe62abd211bfbc9a326359e625244d0b",
	"db2cf369c9fea64aa0d097dd39d8e5b5895bfb2823f1035077a6c507e2b11069",
	"e2d53da75b37429bc648298e6505ceee130308b1e56552909d53ceff3e57eaf9",
	"2c5105ca704f1e099537f643eeb08c556d3c0d561abe59aa3eb47ec69dcb4c4b",
	"e5f7f0d4a4ff72df6f979b2b396133dc63f0526735b90aa516126a090629f0b6",
	"81c0fa137ba8b0b53694be332499838d5e659eed1983138feea8d8d489d1dadd",
	"1bc28a0117c4b77f70b6296a7b14b12048df6d8163b050e908a9336f396ea1d6",
	"9fc9da325ee53a7323d3c97338fbee12f7752bf2ff41c0c605e23c9211a2ced2",
	"60063631b5a2414a3e58c68dd3f198b5753474d5f2d107341329a472e6e19d8e",
	"1a0d3fe7163da15379f13b916805a60378176898b3dc2d295b5b37f0dc3aa307",
	"0c586dc0189fcf22d3c6eeb35d7293475a88529a817e080fa4c485b4248e4ec5",
	"5b1b4db67707593ff55f9df5e60b0d481528615564d58d5d91fc7eddd1f1038b",
	"5d12c25d7555a8b4867facf41d8e3ee18391b560cf5fb1d6a55771add2d65102",
	"31b8fe3f99f79bb3646c01284d4a33a22f92145e7e06e5b43a3dfe63c2470d95",
	"7d8e783e103e4c6baca2a78d0ff76914f5abe42a5744c3ec4c2506df03eb5355",
	"942ed43bd3f91c85d373df9c75ac6019e4e21ff4f44a776c755ad2b10fd01eef",
	"b754e96fdf4e7bc0dbd1b38e4106f9208d9e97056f65b4f82a6c37f7ee7bf61a",
	"e50f0639575bd277d2bdcc922c2f2c2bdd9877aef541f8646dc9164949f3d753",
	"d0bda9f642db21c2bb91b082a42ae0df1b8cf90356790d9ab6f51ac0b022f6ea",
	"7e02cb98ed61fc64cec1902d497772445f35976ce0c2e2fb74c32b2d8fa3f312",
	"d879a720a83e65a027efd4df36ec01ea3c4dba202479c8804dfdb5663608724c",
	"99a36882fc84f4f6a20f9107582e3352335936ec3850d35df094242125ec62ba",
	"53e3f95f73e6e5819579805ba5db3309b9e911331f9da44fe90b525d460dbf3a",
	"245436fe8fe44c860612d729447d0dfaa7184fd9337e03aba753c0838cc53ad0",
	"5f3ff12dd38aa75499d6e81c0475dc738e3b98ce26acf04709ad27b12a53e83c",
	"5e883ff22d6ada7f8c87c0f88169841994bb6f0928ff882d8cc288b9b751a671",
	"2d6d0bc98537146df40c5233de3b629c0c5c7435dc9a1a41f7c26acde47c7b75",
	"c3c33e4d468aa3bffc63480ca609888cdadf667736b0114a6c88c553f7fd5141",
	"cbc10e567aa3e7e48e83cd8d31baf325ba616ebbcc0c3b2499b36a15508370b9",
	"2a3a8ebaaa2ce03de1dba7d941a6dd1608678f417d8d8b205f8b37acddb1149d",
	"eb907b3541fa66348e24761c5036ea6880717f9eb24319a2c1412e3b65d9f1ed",
	"8801055f0b51b87e1df6d0277f78b8ab8641f9cd86487f61e4484dde03176b7c",
	"0b9f5f1d64d667ce3e21fec19953eebac8a8767e84fb89d0eb298ee65d92e2a2",
	"9be851cc8a30c30907a58e8fc9afdbd74db15b6cce1c3e7374752661c0460861",
	"5a651afa7addc799ff71b337adf8d7afcc25012702dfa0403e5887a9e9429550",
	"08417bd1088696f4f17bcba46081bea32876aac9cee364d4d643b4d5a3e2b00e",
	"fc7ff5d11d04f1254836e032d5a64d9e3529368dace5f4f11ea5aefd2796a858",
	"ec01820992adaf4e67cb5931db9b3b785a3bab04662b40ad2edd054b0e5f9780",
	"0a9735b8bef81899182fdf0ac8530d5ac5a5e0585c38b7ec2e0aec9af1b38f22",
	"ca0bcc4e41e639d9daf25d35e0352d839265d6a0bcc0a3abdb503f5bf2f56aa3",
	"95cd77160a14cbfdf1372c9af5d3a0e93dcd937d5ff27e59d2a426bc7a0e754d",
	"a9604416c705321ec0a05f8cd1c553ac26e80149e330e00d1f6e05394b80ee85",
	"9a5252107f6cfb1184de7ec7c7b8199efd3de889c5c0759cff3d1dee464f1569",
	"2f079da17c351044e294517490b03457a2a41de42c9874cb3610a1476311add0",
	"90bcf548f86dd880c5f7b413bea27536810b97d88775a2057ee20dc15e1fc97c",
	"79af2c3ddac265f30891d5427e6656c7fc2bf67eb62205d8f741222ad823712b",
	"437adc0a9dad6db638d7a3d665b8f68d2598725907fe63fc5e6a5ca60ea7c045",
]);

const GRACE_PERIOD = 14 * 24 * 60 * 60 * 1000;
const TRIAL_PERIOD = TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;
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

// --- 在线验证 (Gumroad API) ---

async function gumroadVerify(key: string): Promise<{ success: boolean; refunded: boolean; chargebacked: boolean }> {
	try {
		const body = "product_id=" + encodeURIComponent(GUMROAD_PRODUCT_ID) + "&license_key=" + encodeURIComponent(key);
		const resp = await requestUrl({
			url: GUMROAD_VERIFY_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body,
		});
		const data = resp.json;
		return {
			success: !!data.success,
			refunded: !!data.purchase?.refunded,
			chargebacked: !!data.purchase?.chargebacked,
		};
	} catch {
		return { success: false, refunded: false, chargebacked: false };
	}
}

async function onlineActivate(key: string, instanceName: string): Promise<LicenseInfo | null> {
	const result = await gumroadVerify(key);
	if (!result.success || result.refunded || result.chargebacked) return null;
	return {
		key,
		status: "active",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: null,
		trialStart: null,
		instanceId: instanceName,
		freeChatUsed: 0,
		freeChatMonth: "",
		trialExpiredShown: false,
	};
}

async function onlineValidate(key: string, instanceId: string | null): Promise<LicenseInfo | null> {
	const result = await gumroadVerify(key);
	if (!result.success || result.refunded || result.chargebacked) return null;
	return {
		key,
		status: "active",
		plan: "pro",
		expiresAt: null,
		lastValidated: new Date().toISOString(),
		graceStart: null,
		trialStart: null,
		instanceId: instanceId,
		freeChatUsed: 0,
		freeChatMonth: "",
		trialExpiredShown: false,
	};
}

function onlineDeactivate(_key: string, _instanceId: string): boolean {
	return true;
}

// --- 离线验证 (SHA256 哈希) ---

async function offlineVerify(key: string): Promise<boolean> {
	const trimmed = key.trim().toUpperCase();
	const hash = await sha256(trimmed);
	return VALID_HASHES.has(hash);
}

// --- 公开 API ---

export async function activateLicense(key: string, instanceName?: string): Promise<LicenseInfo> {
	if (!checkRateLimit()) {
		throw new Error("SB_RATE_LIMIT");
	}

	const trimmed = key.trim().toUpperCase();

	// 优先尝试在线验证
	if (instanceName) {
		const onlineResult = await onlineActivate(trimmed, instanceName);
		if (onlineResult) return onlineResult;
	}

	// 回退到离线验证
	if (await offlineVerify(trimmed)) {
		return {
			key: trimmed,
			status: "active",
			plan: "pro",
			expiresAt: null,
			lastValidated: new Date().toISOString(),
			graceStart: null,
			trialStart: null,
			instanceId: instanceName || null,
			freeChatUsed: 0,
			freeChatMonth: "",
		trialExpiredShown: false,
		};
	}

	return { ...DEFAULT_LICENSE, key: trimmed, status: "invalid" };
}

export async function validateLicense(key: string, instanceId?: string | null): Promise<LicenseInfo> {
	if (!checkRateLimit()) {
		throw new Error("SB_RATE_LIMIT");
	}

	const trimmed = key.trim().toUpperCase();

	// 优先尝试在线验证
	const onlineResult = await onlineValidate(trimmed, instanceId || null);
	if (onlineResult) return onlineResult;

	// 回退到离线验证
	if (await offlineVerify(trimmed)) {
		return {
			key: trimmed,
			status: "active",
			plan: "pro",
			expiresAt: null,
			lastValidated: new Date().toISOString(),
			graceStart: null,
			trialStart: null,
			instanceId: instanceId || null,
			freeChatUsed: 0,
			freeChatMonth: "",
		trialExpiredShown: false,
		};
	}

	return { ...DEFAULT_LICENSE, key: trimmed, status: "invalid" };
}

export function deactivateLicense(key: string, instanceId: string | null): void {
	if (key && instanceId) {
		onlineDeactivate(key, instanceId);
	}
}

export function isPro(state: LicenseInfo): boolean {
	// Beta 期间统一返回 Pro，所有付费门控临时通过。正式版只需把 BETA_MODE 改 false。
	if (BETA_MODE) return true;
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

// 上次成功验证超过该时长则需要重新联网校验（Pro 用户启动时、定期触发）
const REVALIDATION_INTERVAL = 7 * 24 * 60 * 60 * 1000;

export function needsRevalidation(state: LicenseInfo): boolean {
	if (state.plan !== "pro") return false;
	if (!state.lastValidated) return true;
	const last = new Date(state.lastValidated).getTime();
	if (Number.isNaN(last)) return true;
	return Date.now() - last >= REVALIDATION_INTERVAL;
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
		trialExpiredShown: false,
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
		trialExpiredShown: false,
	};
}

/**
 * 首次编译成功后是否应写入「编译触发的 Pro 试用」。
 * 与 {@link isPro} / {@link BETA_MODE} 解耦：公测全开 Pro 时仍记录试用起点，便于设置页展示剩余天数。
 */
export function shouldStartCompileTrial(state: LicenseInfo, licenseKey: string): boolean {
	if (licenseKey.trim()) return false;
	if (state.status === "active") return false;
	// 老用户迁移 grace 与编译试用分开，避免覆盖 grace 窗口
	if (state.status === "grace") return false;
	if (state.status === "trial" && state.trialStart) return false;
	return true;
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

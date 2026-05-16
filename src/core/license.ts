// License 模块 — 所有功能完全免费开放

import type { LicenseInfo } from "../types";
import { DEFAULT_LICENSE } from "../types";

// --- 公开 API（保留接口兼容，全部返回免费 Pro） ---

export const BETA_MODE = true;
export const TRIAL_PERIOD_DAYS = 14;

export function isPro(_state: LicenseInfo): boolean {
	return true;
}

export function needsRevalidation(_state: LicenseInfo): boolean {
	return false;
}

export function enterGraceIfNeeded(state: LicenseInfo): LicenseInfo {
	return state;
}

export function checkGraceExpiry(state: LicenseInfo): LicenseInfo {
	return state;
}

export function getDefaultLicense(): LicenseInfo {
	return { ...DEFAULT_LICENSE, status: "active", plan: "pro" };
}

export function getTrialLicense(): LicenseInfo {
	return getDefaultLicense();
}

export function getCompileTrialLicense(): LicenseInfo {
	return getDefaultLicense();
}

export function shouldStartCompileTrial(_state: LicenseInfo, _licenseKey: string): boolean {
	return false;
}

export function isTrialActive(_state: LicenseInfo): boolean {
	return true;
}

export function getTrialDaysLeft(_state: LicenseInfo): number {
	return Infinity;
}

export function checkTrialExpiry(state: LicenseInfo): LicenseInfo {
	return state;
}

export function checkFreeChatQuota(_state: LicenseInfo): { allowed: boolean; used: number; limit: number; remaining: number } {
	return { allowed: true, used: 0, limit: Infinity, remaining: Infinity };
}

export function incrementFreeChatUsage(state: LicenseInfo): LicenseInfo {
	return state;
}

export async function activateLicense(_key: string, _instanceName?: string): Promise<LicenseInfo> {
	return getDefaultLicense();
}

export async function validateLicense(_key: string, _instanceId?: string | null): Promise<LicenseInfo> {
	return getDefaultLicense();
}

export function deactivateLicense(_key: string, _instanceId: string | null): void {
	// no-op
}

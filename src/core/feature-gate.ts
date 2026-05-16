// 功能门控模块 — 所有功能免费开放

import type { LicenseInfo } from "../types";

export type FeatureId =
	| "auto-compile"
	| "ai-chat"
	| "multi-llm"
	| "health-check"
	| "advanced-templates"
	| "embedding-config";

export function requirePro(_state: LicenseInfo, _featureId: FeatureId): boolean {
	return true;
}

export function createProBadge(_container: HTMLElement, _lang: string): void {
	// no-op: all features are free
}

export function showUpgradeNotice(): void {
	// no-op: all features are free
}

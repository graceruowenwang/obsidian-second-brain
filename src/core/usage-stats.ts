// 本地使用统计 — 记录编译行为，纯本地不联网

export interface UsageStats {
	totalCompiles: number;
	successCompiles: number;
	failedCompiles: number;
	totalDurationMs: number;
	firstCompileAt: string | null;
	lastCompileAt: string | null;
	totalConceptsGenerated: number;
	totalEntitiesGenerated: number;
	weeklyCompiles: number;
	lastWeekDate: string;
}

export function emptyStats(): UsageStats {
	return {
		totalCompiles: 0,
		successCompiles: 0,
		failedCompiles: 0,
		totalDurationMs: 0,
		firstCompileAt: null,
		lastCompileAt: null,
		totalConceptsGenerated: 0,
		totalEntitiesGenerated: 0,
		weeklyCompiles: 0,
		lastWeekDate: "",
	};
}

export function recordCompile(
	stats: UsageStats,
	result: { success: boolean; durationMs: number; conceptsCount: number; entitiesCount: number },
): UsageStats {
	const now = new Date().toISOString();
	const weekKey = getWeekKey();

	if (!stats.firstCompileAt) stats.firstCompileAt = now;
	stats.lastCompileAt = now;
	stats.totalCompiles++;
	stats.totalDurationMs += result.durationMs;
	stats.totalConceptsGenerated += result.conceptsCount;
	stats.totalEntitiesGenerated += result.entitiesCount;

	if (result.success) {
		stats.successCompiles++;
	} else {
		stats.failedCompiles++;
	}

	if (stats.lastWeekDate !== weekKey) {
		stats.weeklyCompiles = 0;
		stats.lastWeekDate = weekKey;
	}
	stats.weeklyCompiles++;

	return stats;
}

export function getSuccessRate(stats: UsageStats): number {
	if (stats.totalCompiles === 0) return 0;
	return Math.round((stats.successCompiles / stats.totalCompiles) * 100);
}

export function getAvgDurationSec(stats: UsageStats): number {
	if (stats.totalCompiles === 0) return 0;
	return Math.round(stats.totalDurationMs / stats.totalCompiles / 1000);
}

function getWeekKey(): string {
	const now = new Date();
	const start = new Date(now.getFullYear(), 0, 1);
	const diff = now.getTime() - start.getTime();
	const week = Math.ceil((diff / (7 * 24 * 60 * 60 * 1000)) + 1);
	return `${now.getFullYear()}-W${week}`;
}

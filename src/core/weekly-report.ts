// 每周知识报告 — 编译后异步生成周报，追加到 wiki/log.md

import { App, TFile } from "obsidian";
import type { CompileCache } from "../types";

export async function appendWeeklyReport(
	app: App,
	wikiFolder: string,
	cache: CompileCache,
): Promise<void> {
	const today = new Date().toISOString().split("T")[0];
	const lastReport = cache.weeklyReportLastDate || "";

	// 每周只生成一次（按周一判断）
	if (isSameWeek(today, lastReport)) return;

	cache.weeklyReportLastDate = today;

	const history = cache.compileHistory || [];
	if (history.length === 0) return;

	// 取最近 7 天的编译记录
	const weekAgo = new Date();
	weekAgo.setDate(weekAgo.getDate() - 7);
	const recent = history.filter(h => new Date(h.date) >= weekAgo);

	if (recent.length === 0) return;

	const totalAdded = recent.reduce((s, h) => s + h.added.length, 0);
	const totalModified = recent.reduce((s, h) => s + h.modified.length, 0);
	const totalRemoved = recent.reduce((s, h) => s + h.removed.length, 0);
	const avgDuration = Math.round(recent.reduce((s, h) => s + h.durationMs, 0) / recent.length / 1000);
	const totalPages = recent[0]?.totalPages || 0;

	let report = `## [${today}] weekly-report | 本周知识报告\n`;
	report += `- **编译次数**: ${recent.length} 次\n`;
	report += `- **新增概念**: ${totalAdded} 个\n`;
	report += `- **修改概念**: ${totalModified} 个\n`;
	report += `- **删除概念**: ${totalRemoved} 个\n`;
	report += `- **平均耗时**: ${avgDuration}s\n`;
	report += `- **知识库规模**: ${totalPages} 页\n`;

	if (totalAdded > 0) {
		const added = recent.flatMap(h => h.added).slice(0, 10);
		report += `- **本周新增**: ${added.join(", ")}\n`;
	}

	report += "\n";

	// 追加到 wiki/log.md
	const logPath = `${wikiFolder}/log.md`;
	const existing = app.vault.getAbstractFileByPath(logPath);
	if (existing instanceof TFile) {
		const content = await app.vault.read(existing);
		await app.vault.modify(existing, content + "\n" + report);
	} else {
		const folder = wikiFolder;
		if (!app.vault.getAbstractFileByPath(folder)) {
			await app.vault.createFolder(folder);
		}
		await app.vault.create(logPath, report);
	}
}

function isSameWeek(a: string, b: string): boolean {
	if (!b) return false;
	const da = new Date(a);
	const db = new Date(b);
	// 都取到所在周的周一
	const getMonday = (d: Date) => {
		const day = d.getDay();
		const diff = d.getDate() - day + (day === 0 ? -6 : 1);
		return new Date(d.getFullYear(), d.getMonth(), diff).toISOString().split("T")[0];
	};
	return getMonday(da) === getMonday(db);
}

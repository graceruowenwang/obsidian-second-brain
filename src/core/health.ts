// 知识健康度计算模块

import type { WikiPage } from "../views/wiki-shared";
import { extractUpdated, extractFmField, extractStatus } from "../views/wiki-shared";

export interface StalePage {
	name: string;
	path: string;
	lastUpdated: string;
	daysSinceUpdate: number;
	linkCount: number;
	level: string;
}

export interface WikiHealth {
	/** 0-100, 核心概念中超过 STALE_THRESHOLD 天未更新的比例 */
	staleness: number;
	/** 平均每页双向链接数 */
	avgLinkCount: number;
	/** 链接数 < 2 的页面比例 (0-100) */
	orphanRisk: number;
	/** 需要关注的衰减页面 */
	stalePages: StalePage[];
	/** 总页面数 */
	total: number;
	/** 已审核页面数 */
	reviewed: number;
	/** 知识缺口页面数 (status=gap) */
	gapPages: number;
}

const STALE_THRESHOLD_DAYS = 30;
const MAX_STALE_PAGES = 10;

function countLinks(content: string): number {
	const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
	return (stripped.match(/\[\[[^\]]+\]\]/g) || []).length;
}

function daysBetween(dateStr: string, now: Date): number {
	if (!dateStr) return 999;
	const d = new Date(dateStr);
	if (isNaN(d.getTime())) return 999;
	return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

export function computeWikiHealth(wikiPages: WikiPage[]): WikiHealth {
	const now = new Date();
	const conceptPages = wikiPages.filter(f => f.path.includes("concepts/"));
	const allPages = wikiPages.filter(f => !f.path.endsWith("index.md") && !f.path.endsWith("log.md"));
	const total = allPages.length;

	if (total === 0) {
		return { staleness: 0, avgLinkCount: 0, orphanRisk: 0, stalePages: [], total: 0, reviewed: 0, gapPages: 0 };
	}

	let totalLinks = 0;
	let orphanCount = 0;
	let reviewed = 0;
	let gapPages = 0;

	const staleCandidates: StalePage[] = [];

	for (const page of allPages) {
		const lc = countLinks(page.content);
		totalLinks += lc;
		if (lc < 2) orphanCount++;

		const status = extractStatus(page.content);
		if (status === "reviewed") reviewed++;
		if (status === "gap") gapPages++;

		if (!page.path.includes("concepts/")) continue;

		const updated = extractUpdated(page.content);
		const days = daysBetween(updated, now);
		if (days >= STALE_THRESHOLD_DAYS) {
			const name = page.path.split("/").pop()!.replace(".md", "");
			staleCandidates.push({
				name,
				path: page.path,
				lastUpdated: updated,
				daysSinceUpdate: days,
				linkCount: lc,
				level: extractFmField(page.content, "level"),
			});
		}
	}

	staleCandidates.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

	return {
		staleness: conceptPages.length > 0
			? Math.round((staleCandidates.length / conceptPages.length) * 100)
			: 0,
		avgLinkCount: total > 0 ? Math.round((totalLinks / total) * 10) / 10 : 0,
		orphanRisk: total > 0 ? Math.round((orphanCount / total) * 100) : 0,
		stalePages: staleCandidates.slice(0, MAX_STALE_PAGES),
		total,
		reviewed,
		gapPages,
	};
}

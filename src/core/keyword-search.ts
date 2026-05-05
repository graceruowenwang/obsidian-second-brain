// 关键词搜索 — 纯文本匹配，作为 embedding 搜索的 fallback

const MAX_KEYWORDS = 10;

export function findRelevantPages(
	question: string,
	files: Record<string, string>,
	topN = 5
): Array<{ filePath: string; content: string; score: number }> {
	const ql = question.toLowerCase();
	const scored: Array<{ filePath: string; content: string; score: number }> = [];

	for (const [filePath, content] of Object.entries(files)) {
		let score = 0;
		const cl = content.toLowerCase();
		const title = filePath.split("/").pop()!.replace(/\.md$/, "").toLowerCase();

		if (ql.includes(title)) score += 10;

		const keywords = ql
			.replace(/[，。？！、？?！!，,。.、]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 1)
			.slice(0, MAX_KEYWORDS);

		// 只生成前缀和后缀子串，不做全量暴力展开
		const allKeywords: string[] = [];
		for (const kw of keywords) {
			allKeywords.push(kw);
			if (kw.length > 4) {
				allKeywords.push(kw.slice(0, 3));
				allKeywords.push(kw.slice(-3));
			}
		}

		for (const kw of allKeywords) {
			if (cl.includes(kw)) score += 2;
		}

		const links = content.match(/\[\[([^\]|]+)/g) || [];
		for (const link of links) {
			const concept = link.replace("[[", "").toLowerCase();
			if (ql.includes(concept)) score += 5;
		}

		if (score > 0) {
			scored.push({ filePath, content, score });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topN);
}

export function filesToMap(files: Array<{ path: string; content: string }>): Record<string, string> {
	const map: Record<string, string> = {};
	for (const f of files) {
		map[f.path] = f.content;
	}
	return map;
}

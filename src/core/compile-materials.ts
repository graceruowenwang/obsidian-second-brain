// 素材检索 -- 向量检索 + 关键词匹配
// 从 compile-pages.ts 拆分
// embedding 函数统一由 file-utils.ts 提供

import type { PluginSettings } from "../types";
import { filesToMap, buildEmbeddingCache, vectorSearch } from "./file-utils";

// 素材检索（供页面生成使用）
export async function findRelevantMaterials(itemName: string, itemDesc: string, allFiles: Array<{ path: string; content: string }>, settings: PluginSettings, maxChars = 10000): Promise<string> {
	if (settings.embeddingApiKey || settings.apiKey) {
		try {
			const query = `${itemName} ${itemDesc || ""}`;
			const filesMap = filesToMap(allFiles);
			await buildEmbeddingCache(filesMap, settings);
			const results = await vectorSearch(query, filesMap, settings, 8);
			if (results.length > 0) {
				let result = "";
				for (const r of results) {
					if (result.length >= maxChars) break;
					const path = r.filePath;
					const content = r.content || filesMap[path] || "";
					result += `--- 文件: ${path} ---\n${content.slice(0, 3000)}\n\n`;
				}
				if (result) return result.slice(0, maxChars);
			}
		} catch (e) {
			console.warn("compile-materials: embedding fallback:", e);
		}
	}

	return findRelevantMaterialsByKeyword(itemName, itemDesc, allFiles, maxChars);
}

export function findRelevantMaterialsByKeyword(itemName: string, itemDesc: string, allFiles: Array<{ path: string; content: string }>, maxChars = 10000): string {
	const keywords: string[] = [];
	const titleWords = itemName.match(/[A-Z][a-z]+/g) || [];
	keywords.push(...titleWords);
	const segments = (itemDesc || "").split(/[,，、；;？?!！。\s]+/).filter(w => w.length >= 2 && w.length <= 8);
	keywords.push(...segments);
	const uniqueKw = [...new Set(keywords.filter(k => k.length >= 2))];
	if (uniqueKw.length === 0) uniqueKw.push(itemName);
	const kwLower = uniqueKw.map(k => k.toLowerCase());

	const fileInfos = allFiles.map(f => ({
		file: f,
		titleLow: f.path.split("/").pop()!.replace(/\.md$/, "").toLowerCase(),
		headingsLow: (f.content.match(/^#{1,3}\s+(.+)$/gm) || []).join(" ").toLowerCase(),
		contentLow: f.content.toLowerCase(),
	}));

	const scored = fileInfos.map(info => {
		let score = 0;
		for (const kw of kwLower) {
			if (info.titleLow.includes(kw)) score += 8;
			if (info.headingsLow.includes(kw)) score += 5;
			if (info.contentLow.includes(kw)) score += 2;
		}
		return { file: info.file, score };
	});

	const relevant = scored.filter(s => s.score >= 3);
	relevant.sort((a, b) => b.score - a.score);

	let result = "";
	for (const { file, score } of relevant) {
		if (result.length >= maxChars) break;
		const sliceLen = score > 5 ? 3000 : 1500;
		result += `--- 文件: ${file.path} ---\n${file.content.slice(0, sliceLen)}\n\n`;
	}
	if (!result && allFiles.length > 0) {
		for (const f of allFiles.slice(0, 2)) {
			result += `--- 文件: ${f.path} ---\n${f.content.slice(0, 2000)}\n\n`;
		}
	}
	return result.slice(0, maxChars);
}

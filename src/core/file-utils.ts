// 文件操作适配层 — Vault API 替代 Node.js fs
// 从 file-utils.js 移植

import { App, TFile, TFolder, TAbstractFile, Vault } from "obsidian";
import type { CompileCache, Fingerprint } from "../types";

// 递归获取文件夹下所有 .md 文件
export function getAllMdFiles(folder: TFolder): TFile[] {
	const files: TFile[] = [];
	function walk(node: TAbstractFile) {
		if (node instanceof TFile && (node.extension === "md" || node.extension === "txt")) {
			files.push(node);
		} else if (node instanceof TFolder) {
			for (const child of node.children) walk(child);
		}
	}
	walk(folder);
	return files;
}

// 读取 raw/ 目录下所有文件
export async function readRawFiles(app: App, rawFolder: string): Promise<Array<{ path: string; content: string }>> {
	const folder = app.vault.getAbstractFileByPath(rawFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const files: Array<{ path: string; content: string }> = [];
	for (const f of tfiles) {
		const content = await app.vault.read(f);
		files.push({ path: f.path, content });
	}
	return files;
}

// 读取 wiki/ 目录下所有文件
export async function readWikiFiles(app: App, wikiFolder: string): Promise<Array<{ path: string; content: string }>> {
	const folder = app.vault.getAbstractFileByPath(wikiFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const files: Array<{ path: string; content: string }> = [];
	for (const f of tfiles) {
		const content = await app.vault.read(f);
		files.push({ path: f.path.replace(wikiFolder + "/", ""), content });
	}
	return files;
}

// 写入 wiki 文件（确保目录存在）
export async function writeWikiFile(app: App, wikiFolder: string, filePath: string, content: string): Promise<void> {
	const fullPath = `${wikiFolder}/${filePath}`;
	const existing = app.vault.getAbstractFileByPath(fullPath);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
	} else {
		// 确保父目录存在
		const folderPath = fullPath.substring(0, fullPath.lastIndexOf("/"));
		if (folderPath) {
			await ensureFolder(app, folderPath);
		}
		await app.vault.create(fullPath, content);
	}
}

// 删除 wiki 文件
export async function deleteWikiFile(app: App, wikiFolder: string, filePath: string): Promise<void> {
	const fullPath = `${wikiFolder}/${filePath}`;
	const existing = app.vault.getAbstractFileByPath(fullPath);
	if (existing instanceof TFile) {
		await app.vault.delete(existing);
	}
}

// 确保目录存在
async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = folderPath.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (!existing) {
			await app.vault.createFolder(current);
		}
	}
}

// 搜索相关页面（关键词匹配）
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
			.filter((w) => w.length > 1);

		const allKeywords = [...keywords];
		for (const kw of keywords) {
			if (kw.length > 4) {
				for (let len = 2; len <= 4; len++) {
					for (let i = 0; i <= kw.length - len; i++) {
						const sub = kw.slice(i, i + len);
						if (!allKeywords.includes(sub)) allKeywords.push(sub);
					}
				}
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

// 文件数组转映射
export function filesToMap(files: Array<{ path: string; content: string }>): Record<string, string> {
	const map: Record<string, string> = {};
	for (const f of files) {
		map[f.path] = f.content;
	}
	return map;
}

// 内容哈希（用 Web Crypto API 替代 Node crypto）
export async function fileHash(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest("MD5", data).catch(() => null);
	// Web Crypto 不支持 MD5，fallback 到简单哈希
	if (!hashBuffer) {
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash |= 0;
		}
		return Math.abs(hash).toString(16);
	}
	return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// 简单同步哈希（Obsidian 环境没有 Node crypto）
export function simpleHash(content: string): string {
	let hash = 5381;
	for (let i = 0; i < content.length; i++) {
		hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}

// 计算指纹
export function computeFingerprint(content: string): Fingerprint {
	return { m: Date.now(), s: content.length, h: simpleHash(content) };
}

// 空缓存
export function emptyCache(): CompileCache {
	return {
		fingerprints: {},
		analysis: null,
		pages: {},
		analysisTime: null,
		perFileAnalysis: {},
		indexEntries: {},
	};
}

// Diff 指纹：返回变化和未变化的文件
export function diffFingerprints(
	files: Array<{ path: string; content: string }>,
	cache: CompileCache
): { changed: Array<{ path: string; content: string }>; unchanged: Array<{ path: string; content: string }> } {
	const changed: Array<{ path: string; content: string }> = [];
	const unchanged: Array<{ path: string; content: string }> = [];

	for (const f of files) {
		const cached = cache.fingerprints[f.path];
		if (!cached) {
			changed.push(f);
			continue;
		}
		// 先比大小（快速判断）
		if (cached.s !== f.content.length) {
			changed.push(f);
			continue;
		}
		// 大小相同，比哈希
		const h = simpleHash(f.content);
		if (cached.h && cached.h !== h) {
			changed.push(f);
			continue;
		}
		unchanged.push(f);
	}

	return { changed, unchanged };
}

// 更新指纹
export function updateFingerprints(
	files: Array<{ path: string; content: string }>,
	cache: CompileCache
): void {
	for (const f of files) {
		cache.fingerprints[f.path] = computeFingerprint(f.content);
	}
}

// 统计分析条目总数
export function totalAnalysisCount(analysis: any): number {
	if (!analysis) return 0;
	return (analysis.concepts?.length || 0) +
		(analysis.entities?.length || 0) +
		(analysis.sources?.length || 0);
}

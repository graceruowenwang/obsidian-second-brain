// 文件 I/O 适配层 — Vault API 替代 Node.js fs

import { App, TFile, TFolder, TAbstractFile } from "obsidian";
import type { CompileCache } from "../types";

export type StorageLike = { loadData: () => Promise<unknown>; saveData: (data: unknown) => Promise<void> };

/** 控制异步任务并发数 */
export async function parallelWithLimit<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let next = 0;
	async function run() {
		while (next < tasks.length) {
			const i = next++;
			results[i] = await tasks[i]();
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => run()));
	return results;
}

export function getStorage(_app: App, plugin?: StorageLike): StorageLike {
	if (plugin && typeof plugin.loadData === "function") return plugin;
	throw new Error("Plugin instance required for data storage");
}

export function normalizeVaultFolderPath(path: string): string {
	return (path || "")
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+/g, "/")
		.replace(/\/+$/, "");
}

// 递归获取文件夹下所有 .md/.txt 文件
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

// 读取 raw/ 目录下所有文件（并发读取，限制同时 20 个）
export async function readRawFiles(app: App, rawFolder: string): Promise<Array<{ path: string; content: string }>> {
	const normalized = normalizeVaultFolderPath(rawFolder);
	const folder = app.vault.getAbstractFileByPath(normalized) ?? app.vault.getAbstractFileByPath(rawFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const contents = await parallelWithLimit(tfiles.map(f => () => app.vault.cachedRead(f)), 20);
	return tfiles.map((f, i) => ({ path: f.path, content: contents[i] }));
}

// 读取 wiki/ 目录下所有文件（并发读取，限制同时 20 个）
export async function readWikiFiles(app: App, wikiFolder: string): Promise<Array<{ path: string; content: string }>> {
	const normalized = normalizeVaultFolderPath(wikiFolder);
	const folder = app.vault.getAbstractFileByPath(normalized) ?? app.vault.getAbstractFileByPath(wikiFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const contents = await parallelWithLimit(tfiles.map(f => () => app.vault.cachedRead(f)), 20);
	const prefix = normalized + "/";
	return tfiles.map((f, i) => ({ path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path, content: contents[i] }));
}

/** 轻量扫描：只读文件列表 + frontmatter 摘要（前 600 字符） */
export async function scanWikiFiles(app: App, wikiFolder: string): Promise<Array<{ path: string; content: string }>> {
	const normalized = normalizeVaultFolderPath(wikiFolder);
	const folder = app.vault.getAbstractFileByPath(normalized) ?? app.vault.getAbstractFileByPath(wikiFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const contents = await parallelWithLimit(
		tfiles.map(f => () => app.vault.cachedRead(f).then(c => c.slice(0, 600))),
		20,
	);
	const prefix = normalized + "/";
	return tfiles.map((f, i) => ({ path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path, content: contents[i] }));
}

/** 按需读取单个 wiki 文件的完整内容 */
export async function readWikiPage(app: App, wikiFolder: string, relPath: string): Promise<string> {
	const fullPath = `${wikiFolder}/${relPath}`;
	const file = app.vault.getAbstractFileByPath(fullPath);
	if (file instanceof TFile) return app.vault.cachedRead(file);
	return "";
}

// 写入 wiki 文件（确保目录存在）
export async function writeWikiFile(app: App, wikiFolder: string, filePath: string, content: string): Promise<void> {
	const fullPath = `${wikiFolder}/${filePath}`;
	await safeVaultWrite(app, fullPath, content);
}

// 安全写入文件：存在则 modify，不存在则 create
async function safeVaultWrite(app: App, fullPath: string, content: string): Promise<void> {
	const folderPath = fullPath.substring(0, fullPath.lastIndexOf("/"));
	if (folderPath) await ensureFolder(app, folderPath);
	const existing = app.vault.getAbstractFileByPath(fullPath);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
		return;
	}
	await app.vault.create(fullPath, content);
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
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const normalized = normalizeVaultFolderPath(folderPath);
	if (!normalized) return;
	const already = app.vault.getAbstractFileByPath(normalized);
	if (already instanceof TFolder) return;

	const parts = normalized.split("/");
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (!existing) {
			try {
				await app.vault.createFolder(current);
			} catch (e) {
				if (!app.vault.getAbstractFileByPath(current)) throw e;
			}
		}
	}
}

// 追加写入 log.md 操作日志
export async function writeLogEntry(
	app: App,
	wikiFolder: string,
	action: "ingest" | "query" | "lint" | "sync",
	summary: string,
	details?: string,
): Promise<void> {
	const logPath = `${wikiFolder}/log.md`;
	const today = new Date().toISOString().split("T")[0];
	let entry = `\n## [${today}] ${action} | ${summary}\n`;
	if (details) entry += `${details}\n`;

	const existing = app.vault.getAbstractFileByPath(logPath);
	if (existing instanceof TFile) {
		let content = await app.vault.read(existing);
		const entries = content.split(/\n(?=## \[)/);
		if (entries.length > 200) {
			const header = entries[0];
			content = header + "\n" + entries.slice(-100).join("\n");
		}
		await app.vault.modify(existing, content + entry);
	} else {
		await ensureFolder(app, wikiFolder);
		const header = `---\ntitle: "操作日志"\ntype: log\nlast_updated: ${today}\n---\n\n# 操作日志`;
		await app.vault.create(logPath, header + entry);
	}
}

// 统计分析条目总数
export function totalAnalysisCount(analysis: { concepts?: unknown[]; entities?: unknown[]; sources?: unknown[] } | null): number {
	if (!analysis) return 0;
	return (analysis.concepts?.length || 0) +
		(analysis.entities?.length || 0) +
		(analysis.sources?.length || 0);
}

// 空缓存
export function emptyCache(): CompileCache {
	return {
		version: 3,
		fingerprints: {},
		analysis: null,
		pages: {},
		analysisTime: null,
		perFileAnalysis: {},
		indexEntries: {},
		failedPages: {},
		dependencies: {},
	};
}

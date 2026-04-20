// 文件操作适配层 — Vault API 替代 Node.js fs
// 从 file-utils.js 移植

import { App, TFile, TFolder, TAbstractFile } from "obsidian";
import { requestUrl } from "obsidian";
import type { CompileCache, Fingerprint, PluginSettings, EmbeddingStore } from "../types";

export type StorageLike = { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> };

export function getStorage(_app: App, plugin?: StorageLike): StorageLike {
	if (plugin && typeof plugin.loadData === "function") return plugin;
	throw new Error("Plugin instance required for data storage");
}

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

// 读取 raw/ 目录下所有文件（并行读取）
export async function readRawFiles(app: App, rawFolder: string): Promise<Array<{ path: string; content: string }>> {
	const folder = app.vault.getAbstractFileByPath(rawFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const contents = await Promise.all(tfiles.map(f => app.vault.cachedRead(f)));
	return tfiles.map((f, i) => ({ path: f.path, content: contents[i] }));
}

// 读取 wiki/ 目录下所有文件（并行读取）
export async function readWikiFiles(app: App, wikiFolder: string): Promise<Array<{ path: string; content: string }>> {
	const folder = app.vault.getAbstractFileByPath(wikiFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const contents = await Promise.all(tfiles.map(f => app.vault.cachedRead(f)));
	return tfiles.map((f, i) => ({ path: f.path.replace(wikiFolder + "/", ""), content: contents[i] }));
}

// 写入 wiki 文件（确保目录存在）
export async function writeWikiFile(app: App, wikiFolder: string, filePath: string, content: string): Promise<void> {
	const fullPath = `${wikiFolder}/${filePath}`;
	const existing = app.vault.getAbstractFileByPath(fullPath);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
	} else {
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
export async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const parts = folderPath.split("/");
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

// 简单同步哈希
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
		if (cached.s !== f.content.length) {
			changed.push(f);
			continue;
		}
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

// === 向量检索 (Embedding-based) — 封装为 class ===

const EMBEDDING_CACHE_DIR = ".cache";
const EMBEDDING_CACHE_FILE = "embeddings.json";

class EmbeddingManager {
	private cache = new Map<string, number[]>();
	private built = false;
	private loaded = false;

	private storePath(wikiFolder: string): string {
		return `${wikiFolder}/${EMBEDDING_CACHE_DIR}/${EMBEDDING_CACHE_FILE}`;
	}

	reset(): void {
		this.cache = new Map();
		this.built = false;
		this.loaded = false;
	}

	get isBuilt(): boolean { return this.built; }
	get size(): number { return this.cache.size; }

	async load(app: App, wikiFolder: string): Promise<void> {
		if (this.loaded) return;
		const file = app.vault.getAbstractFileByPath(this.storePath(wikiFolder));
		if (file instanceof TFile) {
			try {
				const raw = await app.vault.read(file);
				const store: EmbeddingStore = JSON.parse(raw);
				if (store.version === 1 && store.embeddings) {
					this.cache = new Map(Object.entries(store.embeddings));
					this.built = true;
				}
			} catch (e) {
				console.warn("file-utils: embedding store load failed:", e);
			}
		}
		this.loaded = true;
	}

	async migrate(app: App, wikiFolder: string, data: { embeddings?: Record<string, number[]> }): Promise<void> {
		if (!data.embeddings || Object.keys(data.embeddings).length === 0) return;
		const store: EmbeddingStore = { version: 1, embeddings: data.embeddings };
		await this.saveStore(app, wikiFolder, store);
		this.cache = new Map(Object.entries(data.embeddings));
		this.built = true;
		this.loaded = true;
		delete data.embeddings;
	}

	async saveStore(app: App, wikiFolder: string, store: EmbeddingStore): Promise<void> {
		const dirPath = `${wikiFolder}/${EMBEDDING_CACHE_DIR}`;
		await ensureFolder(app, dirPath);
		const filePath = this.storePath(wikiFolder);
		const json = JSON.stringify(store);
		const existing = app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			await app.vault.modify(existing, json);
		} else {
			await app.vault.create(filePath, json);
		}
	}

	async flush(app: App, wikiFolder: string): Promise<void> {
		if (this.cache.size === 0) return;
		await this.saveStore(app, wikiFolder, {
			version: 1,
			embeddings: Object.fromEntries(this.cache),
		});
	}

	has(path: string): boolean { return this.cache.has(path); }
	get(path: string): number[] | undefined { return this.cache.get(path); }

	async build(
		files: Record<string, string>,
		settings: PluginSettings,
		onProgress?: (done: number, total: number) => void,
	): Promise<void> {
		if (!settings.embeddingApiKey && !settings.apiKey) {
			this.built = false;
			return;
		}

		const entries = Object.entries(files);
		const newCache = new Map<string, number[]>();
		let done = 0;

		for (const [path, content] of entries) {
			if (this.cache.has(path)) {
				newCache.set(path, this.cache.get(path)!);
				done++;
				continue;
			}
			try {
				const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
				const vec = await getEmbedding(stripped.slice(0, 500), settings);
				newCache.set(path, vec);
			} catch (e) {
				console.warn("file-utils: embedding failed:", e);
			}
			done++;
			if (onProgress) onProgress(done, entries.length);
		}

		this.cache = newCache;
		this.built = true;
	}

	async search(
		query: string,
		files: Record<string, string>,
		settings: PluginSettings,
		topN = 5,
	): Promise<Array<{ filePath: string; content: string; score: number }>> {
		if (!this.built || this.cache.size === 0) {
			return findRelevantPages(query, files, topN);
		}
		try {
			const queryVec = await getEmbedding(query, settings);
			const scored: Array<{ filePath: string; content: string; score: number }> = [];
			for (const [path, vec] of this.cache) {
				const similarity = cosineSimilarity(queryVec, vec);
				if (similarity > 0.3) {
					scored.push({ filePath: path, content: files[path] || "", score: similarity });
				}
			}
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, topN);
		} catch (e) {
			console.warn("file-utils: embedding fallback:", e);
			return findRelevantPages(query, files, topN);
		}
	}
}

// 全局单例
const embeddingManager = new EmbeddingManager();

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

async function getEmbedding(text: string, settings: PluginSettings): Promise<number[]> {
	const url = settings.embeddingBaseUrl.replace(/\/+$/, "") + "/embeddings";
	const apiKey = settings.embeddingApiKey || settings.apiKey;
	const res = await requestUrl({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: settings.embeddingModel,
			input: text.slice(0, 2000),
		}),
	});
	return res.json.data[0].embedding;
}

// 兼容导出
export async function migrateEmbeddingsToStore(app: App, wikiFolder: string, cache: { embeddings?: Record<string, number[]> }): Promise<void> {
	return embeddingManager.migrate(app, wikiFolder, cache);
}
export async function restoreEmbeddingStore(app: App, wikiFolder: string): Promise<void> {
	return embeddingManager.load(app, wikiFolder);
}
export async function flushEmbeddingStore(app: App, wikiFolder: string): Promise<void> {
	return embeddingManager.flush(app, wikiFolder);
}
export async function buildEmbeddingCache(files: Record<string, string>, settings: PluginSettings, onProgress?: (done: number, total: number) => void): Promise<void> {
	return embeddingManager.build(files, settings, onProgress);
}
export async function vectorSearch(query: string, files: Record<string, string>, settings: PluginSettings, topN = 5): Promise<Array<{ filePath: string; content: string; score: number }>> {
	return embeddingManager.search(query, files, settings, topN);
}
export function clearEmbeddingCache(): void {
	embeddingManager.reset();
}

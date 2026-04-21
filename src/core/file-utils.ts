// 文件操作适配层 — Vault API 替代 Node.js fs
// 从 file-utils.js 移植

import { App, TFile, TFolder, TAbstractFile } from "obsidian";
import { requestUrl } from "obsidian";
import type {
	CompileCache, Fingerprint, PluginSettings,
	EmbeddingStore, EmbeddingStoreMeta, EmbeddingStoreV2,
} from "../types";

export type StorageLike = { loadData: () => Promise<any>; saveData: (data: any) => Promise<void> };

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
	const normalized = normalizeVaultFolderPath(rawFolder);
	const folder = app.vault.getAbstractFileByPath(normalized) ?? app.vault.getAbstractFileByPath(rawFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const contents = await Promise.all(tfiles.map(f => app.vault.cachedRead(f)));
	return tfiles.map((f, i) => ({ path: f.path, content: contents[i] }));
}

// 读取 wiki/ 目录下所有文件（并行读取）
export async function readWikiFiles(app: App, wikiFolder: string): Promise<Array<{ path: string; content: string }>> {
	const normalized = normalizeVaultFolderPath(wikiFolder);
	const folder = app.vault.getAbstractFileByPath(normalized) ?? app.vault.getAbstractFileByPath(wikiFolder);
	if (!folder || !(folder instanceof TFolder)) return [];
	const tfiles = getAllMdFiles(folder);
	const contents = await Promise.all(tfiles.map(f => app.vault.cachedRead(f)));
	const prefix = normalized + "/";
	return tfiles.map((f, i) => ({ path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path, content: contents[i] }));
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

export function normalizeEmbeddingBaseUrl(url: string): string {
	return url.replace(/\/+$/, "");
}

export function embeddingMetaForSettings(settings: PluginSettings, dim: number): EmbeddingStoreMeta {
	return {
		baseUrl: normalizeEmbeddingBaseUrl(settings.embeddingBaseUrl),
		model: settings.embeddingModel,
		dim,
	};
}

function inferDimFromEmbeddings(embeddings: Record<string, number[]>): number {
	for (const v of Object.values(embeddings)) {
		if (Array.isArray(v) && v.length > 0 && v.every(n => typeof n === "number" && Number.isFinite(n))) {
			return v.length;
		}
	}
	return 0;
}

function metaMatchesDisk(meta: EmbeddingStoreMeta, settings: PluginSettings, dimFromData: number): boolean {
	const want = embeddingMetaForSettings(settings, dimFromData || meta.dim);
	return meta.baseUrl === want.baseUrl && meta.model === want.model && meta.dim === want.dim && meta.dim > 0;
}

/** 解析 OpenAI-compatible /embeddings 响应体，失败时抛出带上下文的 Error */
export function parseEmbeddingResponseBody(body: unknown): number[] {
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data) || data.length === 0) {
		const preview = typeof body === "object" && body !== null
			? JSON.stringify(body).slice(0, 280)
			: String(body).slice(0, 280);
		throw new Error(`Embedding 响应结构异常（无 data[]）: ${preview}`);
	}
	const emb = (data[0] as { embedding?: unknown })?.embedding;
	if (!Array.isArray(emb) || emb.length === 0 || !emb.every(x => typeof x === "number" && Number.isFinite(x))) {
		throw new Error("Embedding 响应结构异常（无有效 embedding 向量）");
	}
	return emb as number[];
}

class EmbeddingManager {
	private cache = new Map<string, number[]>();
	private built = false;
	private loaded = false;
	/** 当前内存向量对应的 API 身份；与磁盘 v2.meta 一致 */
	private activeMeta: EmbeddingStoreMeta | null = null;

	private storePath(wikiFolder: string): string {
		return `${wikiFolder}/${EMBEDDING_CACHE_DIR}/${EMBEDDING_CACHE_FILE}`;
	}

	reset(): void {
		this.cache = new Map();
		this.built = false;
		this.loaded = false;
		this.activeMeta = null;
	}

	get isBuilt(): boolean { return this.built; }
	get size(): number { return this.cache.size; }

	private clearIncompatibleStore(): void {
		this.cache = new Map();
		this.built = false;
		this.activeMeta = null;
	}

	async load(app: App, wikiFolder: string, settings?: PluginSettings): Promise<void> {
		if (this.loaded) return;
		const file = app.vault.getAbstractFileByPath(this.storePath(wikiFolder));
		if (file instanceof TFile) {
			try {
				const raw = await app.vault.read(file);
				const store = JSON.parse(raw) as EmbeddingStore;
				const emb = store?.embeddings;
				if (!emb || typeof emb !== "object") {
					this.loaded = true;
					return;
				}
				const dim = inferDimFromEmbeddings(emb);
				if (store.version === 2 && "meta" in store && store.meta) {
					if (dim > 0 && store.meta.dim !== dim) {
						console.warn("file-utils: embedding store dim mismatch, ignoring disk cache");
						this.clearIncompatibleStore();
					} else if (settings && !metaMatchesDisk(store.meta, settings, dim)) {
						console.warn("file-utils: embedding model/baseUrl 与设置不一致，忽略磁盘向量缓存");
						this.clearIncompatibleStore();
					} else {
						this.cache = new Map(Object.entries(emb));
						this.built = this.cache.size > 0;
						this.activeMeta = store.meta;
					}
				} else if (store.version === 1) {
					// 旧格式：无法得知当初用的 model/url，仅在能提供 settings 时按当前身份接纳并在下次 flush 写成 v2
					if (settings && dim > 0) {
						this.cache = new Map(Object.entries(emb));
						this.built = this.cache.size > 0;
						this.activeMeta = embeddingMetaForSettings(settings, dim);
					} else {
						console.warn("file-utils: 检测到 v1 embedding 缓存但无 settings，跳过加载（请重新编译以重建向量）");
					}
				}
			} catch (e) {
				console.warn("file-utils: embedding store load failed:", e);
			}
		}
		this.loaded = true;
	}

	async migrate(
		app: App,
		wikiFolder: string,
		data: { embeddings?: Record<string, number[]> },
		settings: PluginSettings,
	): Promise<void> {
		if (!data.embeddings || Object.keys(data.embeddings).length === 0) return;
		const dim = inferDimFromEmbeddings(data.embeddings);
		if (dim <= 0) return;
		const meta = embeddingMetaForSettings(settings, dim);
		const store: EmbeddingStoreV2 = { version: 2, meta, embeddings: data.embeddings };
		await this.saveStore(app, wikiFolder, store);
		this.cache = new Map(Object.entries(data.embeddings));
		this.built = true;
		this.loaded = true;
		this.activeMeta = meta;
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

	async flush(app: App, wikiFolder: string, settings: PluginSettings): Promise<void> {
		if (this.cache.size === 0) return;
		const first = this.cache.values().next().value as number[] | undefined;
		const dim = first?.length ?? this.activeMeta?.dim ?? 0;
		if (dim <= 0) return;
		const meta = embeddingMetaForSettings(settings, dim);
		this.activeMeta = meta;
		await this.saveStore(app, wikiFolder, {
			version: 2,
			meta,
			embeddings: Object.fromEntries(this.cache),
		});
	}

	has(path: string): boolean { return this.cache.has(path); }
	get(path: string): number[] | undefined { return this.cache.get(path); }

	async build(
		files: Record<string, string>,
		settings: PluginSettings,
		onProgress?: (done: number, total: number) => void,
		signal?: AbortSignal,
	): Promise<void> {
		if (!settings.embeddingApiKey && !settings.apiKey) {
			this.built = false;
			return;
		}

		const entries = Object.entries(files);
		const newCache = new Map<string, number[]>();
		let done = 0;

		for (const [path, content] of entries) {
			if (signal?.aborted) break;
			let reused = false;
			if (this.cache.has(path)) {
				const existing = this.cache.get(path)!;
				const dimOk = !this.activeMeta || existing.length === this.activeMeta.dim;
				if (dimOk) {
					newCache.set(path, existing);
					reused = true;
				}
			}
			if (!reused) {
				try {
					const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
					const vec = await getEmbedding(stripped.slice(0, 500), settings, signal);
					if (this.activeMeta && vec.length !== this.activeMeta.dim) {
						console.warn("file-utils: embedding dim changed mid-build, clearing cache");
						newCache.clear();
						this.activeMeta = embeddingMetaForSettings(settings, vec.length);
					} else if (!this.activeMeta) {
						this.activeMeta = embeddingMetaForSettings(settings, vec.length);
					}
					newCache.set(path, vec);
				} catch (e) {
					console.warn("file-utils: embedding failed:", e);
				}
			}
			done++;
			if (onProgress) onProgress(done, entries.length);
		}

		this.cache = newCache;
		this.built = this.cache.size > 0;
	}

	async search(
		query: string,
		files: Record<string, string>,
		settings: PluginSettings,
		topN = 5,
		signal?: AbortSignal,
	): Promise<Array<{ filePath: string; content: string; score: number }>> {
		if (!this.built || this.cache.size === 0) {
			return findRelevantPages(query, files, topN);
		}
		try {
			const queryVec = await getEmbedding(query, settings, signal);
			const scored: Array<{ filePath: string; content: string; score: number }> = [];
			for (const [path, vec] of this.cache) {
				if (queryVec.length !== vec.length) continue;
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

async function getEmbedding(text: string, settings: PluginSettings, signal?: AbortSignal): Promise<number[]> {
	const url = normalizeEmbeddingBaseUrl(settings.embeddingBaseUrl) + "/embeddings";
	const apiKey = settings.embeddingApiKey || settings.apiKey;
	let res;
	try {
		res = await requestUrl({
			url,
			method: "POST",
			throw: false,
			...(signal ? { signal } : {}),
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: settings.embeddingModel,
				input: text.slice(0, 2000),
			}),
		});
	} catch (e) {
		throw new Error(`Embedding 网络请求失败: ${(e as Error).message}`);
	}

	if (res.status < 200 || res.status >= 300) {
		const bodyText = typeof res.json === "object" && res.json !== null
			? JSON.stringify(res.json).slice(0, 300)
			: (res.text || "").slice(0, 300);
		throw new Error(`Embedding API ${res.status}: ${bodyText}`);
	}

	return parseEmbeddingResponseBody(res.json);
}

// 兼容导出
export async function migrateEmbeddingsToStore(
	app: App,
	wikiFolder: string,
	cache: { embeddings?: Record<string, number[]> },
	settings: PluginSettings,
): Promise<void> {
	return embeddingManager.migrate(app, wikiFolder, cache, settings);
}
export async function restoreEmbeddingStore(app: App, wikiFolder: string, settings?: PluginSettings): Promise<void> {
	return embeddingManager.load(app, wikiFolder, settings);
}
export async function flushEmbeddingStore(app: App, wikiFolder: string, settings: PluginSettings): Promise<void> {
	return embeddingManager.flush(app, wikiFolder, settings);
}
export async function buildEmbeddingCache(
	files: Record<string, string>,
	settings: PluginSettings,
	onProgress?: (done: number, total: number) => void,
	signal?: AbortSignal,
): Promise<void> {
	return embeddingManager.build(files, settings, onProgress, signal);
}
export async function vectorSearch(
	query: string,
	files: Record<string, string>,
	settings: PluginSettings,
	topN = 5,
	signal?: AbortSignal,
): Promise<Array<{ filePath: string; content: string; score: number }>> {
	return embeddingManager.search(query, files, settings, topN, signal);
}
export function clearEmbeddingCache(): void {
	embeddingManager.reset();
}

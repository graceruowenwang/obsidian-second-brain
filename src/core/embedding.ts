// 向量检索 — Embedding 管理、余弦相似度、向量搜索

import { App, TFile } from "obsidian";
import { requestUrl } from "obsidian";
import type { PluginSettings } from "../types";
import type { EmbeddingStoreMeta, EmbeddingStoreV2, EmbeddingStore } from "../types";
import { ensureFolder } from "./file-io";
import { findRelevantPages } from "./keyword-search";

const EMBEDDING_CACHE_DIR = ".cache";
const EMBEDDING_CACHE_FILE = "embeddings.json";
const EMBEDDING_BATCH_SIZE = 20;

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
		throw new Error(`SB_EMBED_NO_DATA:${preview}`);
	}
	const emb = (data[0] as { embedding?: unknown })?.embedding;
	if (!Array.isArray(emb) || emb.length === 0 || !emb.every(x => typeof x === "number" && Number.isFinite(x))) {
		throw new Error("SB_EMBED_INVALID");
	}
	return emb as number[];
}

/** 解析批量 embedding 响应体，返回向量数组 */
function parseBatchEmbeddingResponse(body: unknown): number[][] {
	const data = (body as { data?: unknown })?.data;
	if (!Array.isArray(data) || data.length === 0) {
		throw new Error("SB_EMBED_NO_DATA");
	}
	return data.map((item: any) => {
		const emb = item?.embedding;
		if (!Array.isArray(emb) || !emb.every((x: unknown) => typeof x === "number" && Number.isFinite(x as number))) {
			throw new Error("SB_EMBED_INVALID");
		}
		return emb as number[];
	});
}

class EmbeddingManager {
	private cache = new Map<string, number[]>();
	private built = false;
	private loaded = false;
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
						console.warn("embedding: dim mismatch, ignoring disk cache");
						this.clearIncompatibleStore();
					} else if (settings && !metaMatchesDisk(store.meta, settings, dim)) {
						console.warn("embedding: model/baseUrl mismatch, ignoring disk cache");
						this.clearIncompatibleStore();
					} else {
						this.cache = new Map(Object.entries(emb));
						this.built = this.cache.size > 0;
						this.activeMeta = store.meta;
					}
				} else if (store.version === 1) {
					if (settings && dim > 0) {
						this.cache = new Map(Object.entries(emb));
						this.built = this.cache.size > 0;
						this.activeMeta = embeddingMetaForSettings(settings, dim);
					} else {
						console.warn("embedding: v1 cache without settings, skipping");
					}
				}
			} catch (e) {
				console.warn("embedding: load failed:", e);
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

		// 分离需要新计算的条目和可复用的条目
		const toCompute: Array<{ path: string; content: string }> = [];
		for (const [path, content] of entries) {
			if (signal?.aborted) break;
			if (this.cache.has(path)) {
				const existing = this.cache.get(path)!;
				const dimOk = !this.activeMeta || existing.length === this.activeMeta.dim;
				if (dimOk) {
					newCache.set(path, existing);
					done++;
					if (onProgress) onProgress(done, entries.length);
					continue;
				}
			}
			toCompute.push({ path, content });
		}

		// 批量获取 embedding
		for (let i = 0; i < toCompute.length; i += EMBEDDING_BATCH_SIZE) {
			if (signal?.aborted) break;
			const batch = toCompute.slice(i, i + EMBEDDING_BATCH_SIZE);
			const texts = batch.map(e => {
				const stripped = e.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
				return stripped.slice(0, 500);
			});

			try {
				const vectors = await getEmbeddingBatch(texts, settings, signal);
				for (let j = 0; j < batch.length; j++) {
					const vec = vectors[j];
					if (!vec) continue;
					if (this.activeMeta && vec.length !== this.activeMeta.dim) {
						console.warn("embedding: dim changed mid-build, clearing cache");
						newCache.clear();
						this.activeMeta = embeddingMetaForSettings(settings, vec.length);
					} else if (!this.activeMeta) {
						this.activeMeta = embeddingMetaForSettings(settings, vec.length);
					}
					newCache.set(batch[j].path, vec);
				}
			} catch (e) {
				// 批量失败时降级为逐条获取
				console.warn("embedding: batch failed, falling back to single:", e);
				for (const entry of batch) {
					if (signal?.aborted) break;
					try {
						const stripped = entry.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
						const vec = await getEmbedding(stripped.slice(0, 500), settings, signal);
						if (this.activeMeta && vec.length !== this.activeMeta.dim) {
							newCache.clear();
							this.activeMeta = embeddingMetaForSettings(settings, vec.length);
						} else if (!this.activeMeta) {
							this.activeMeta = embeddingMetaForSettings(settings, vec.length);
						}
						newCache.set(entry.path, vec);
					} catch (e2) {
						console.warn("embedding: single failed:", e2);
					}
					done++;
					if (onProgress) onProgress(done, entries.length);
				}
				done += batch.length;
				if (onProgress) onProgress(done, entries.length);
				continue;
			}
			done += batch.length;
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
			console.warn("embedding: search fallback:", e);
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
		throw new Error(`SB_EMBED_NETWORK: ${(e as Error).message}`);
	}

	if (res.status < 200 || res.status >= 300) {
		const bodyText = typeof res.json === "object" && res.json !== null
			? JSON.stringify(res.json).slice(0, 300)
			: (res.text || "").slice(0, 300);
		throw new Error(`Embedding API ${res.status}: ${bodyText}`);
	}

	return parseEmbeddingResponseBody(res.json);
}

/** 批量获取 embedding：利用 API 的 input 数组支持 */
async function getEmbeddingBatch(texts: string[], settings: PluginSettings, signal?: AbortSignal): Promise<number[][]> {
	if (texts.length === 1) {
		return [await getEmbedding(texts[0], settings, signal)];
	}
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
				input: texts.map(t => t.slice(0, 2000)),
			}),
		});
	} catch (e) {
		throw new Error(`SB_EMBED_NETWORK: ${(e as Error).message}`);
	}

	if (res.status < 200 || res.status >= 300) {
		const bodyText = typeof res.json === "object" && res.json !== null
			? JSON.stringify(res.json).slice(0, 300)
			: (res.text || "").slice(0, 300);
		throw new Error(`Embedding API ${res.status}: ${bodyText}`);
	}

	return parseBatchEmbeddingResponse(res.json);
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

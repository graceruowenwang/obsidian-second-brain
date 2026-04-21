// Embedding 存储 + API 相关类型

export interface EmbeddingStoreMeta {
	baseUrl: string;
	model: string;
	dim: number;
}

/** 旧格式：无 meta，加载后会在下次 flush 时按当前 settings 写入 v2 */
export interface EmbeddingStoreV1 {
	version: 1;
	embeddings: Record<string, number[]>;
}

/** 当前格式：切换 model/baseUrl 或维度不一致时丢弃缓存 */
export interface EmbeddingStoreV2 {
	version: 2;
	meta: EmbeddingStoreMeta;
	embeddings: Record<string, number[]>;
}

export type EmbeddingStore = EmbeddingStoreV1 | EmbeddingStoreV2;

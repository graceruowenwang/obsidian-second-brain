// Re-export barrel — file-utils 已拆分为 4 个子模块
// 所有消费方 import 路径不变

// file-io: 文件读写、目录操作、Vault 适配
export {
	type StorageLike,
	getStorage,
	normalizeVaultFolderPath,
	getAllMdFiles,
	readRawFiles,
	readWikiFiles,
	scanWikiFiles,
	readWikiPage,
	writeWikiFile,
	deleteWikiFile,
	ensureFolder,
	writeLogEntry,
	totalAnalysisCount,
	emptyCache,
	parallelWithLimit,
} from "./file-io";

// fingerprint: 指纹计算与 diff
export {
	simpleHash,
	computeFingerprint,
	diffFingerprints,
	updateFingerprints,
} from "./fingerprint";

// embedding: 向量搜索
export {
	normalizeEmbeddingBaseUrl,
	embeddingMetaForSettings,
	parseEmbeddingResponseBody,
	migrateEmbeddingsToStore,
	restoreEmbeddingStore,
	flushEmbeddingStore,
	buildEmbeddingCache,
	vectorSearch,
	clearEmbeddingCache,
} from "./embedding";

// keyword-search: 关键词搜索
export {
	findRelevantPages,
	filesToMap,
} from "./keyword-search";

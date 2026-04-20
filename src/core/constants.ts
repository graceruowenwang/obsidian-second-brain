// 编译引擎常量 — 集中管理魔法数字

/** 增量分析时单个文件截断字符数 */
export const SLICE_INCREMENTAL_FILE = 3000;

/** 全量分析时单个文件截断字符数 */
export const SLICE_FULL_ANALYSIS_FILE = 2000;

/** 单次 LLM 调用最大输入字符数 */
export const MAX_LLM_INPUT_CHARS = 60000;

/** 分析接口最大输出 token 数 */
export const ANALYSIS_MAX_TOKENS = 4000;

/** 编译历史最大条目数 */
export const MAX_COMPILE_HISTORY = 50;

/** 页面生成前置检查读取头部长度 */
export const PAGE_HEAD_CHECK_CHARS = 500;

/** Embedding 输入截断字符数 */
export const EMBEDDING_INPUT_CHARS = 2000;

/** Embedding 内容前 N 字符 */
export const EMBEDDING_CONTENT_CHARS = 500;

/** 概念页素材截断字符数 */
export const MATERIAL_CONCEPT_CHARS = 10000;

/** 实体页素材截断字符数 */
export const MATERIAL_ENTITY_CHARS = 8000;

/** 来源页素材截断字符数 */
export const MATERIAL_SOURCE_CHARS = 10000;

/** 向量检索默认 topN */
export const VECTOR_SEARCH_TOP_N = 5;

/** 对话上下文最大轮数 */
export const CHAT_MAX_CONTEXT_ROUNDS = 20;

/** 对话系统提示中单页截断字符数 */
export const CHAT_CONTEXT_PAGE_CHARS = 2000;

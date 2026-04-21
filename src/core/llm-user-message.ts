// 将 LLM 异常转换为用户可读文案（编译面板 / 设置测试连接 / 对话等共用）

import { LLMError, type LLMErrorCode } from "./llm";
import { t } from "./i18n";

function messageFromCode(lang: string, code: LLMErrorCode, fallbackMsg: string): string {
	switch (code) {
		case "rate_limit":
			return t("compile.error.rateLimit", lang);
		case "auth":
			return t("compile.error.auth", lang);
		case "timeout":
			return t("compile.error.timeout", lang);
		case "network":
			return t("compile.error.network", lang);
		case "context_length":
			return t("compile.error.contextLength", lang);
		case "bad_request":
			return t("compile.error.badRequest", lang);
		case "invalid_response":
			return t("compile.error.parseError", lang);
		case "server":
			return t("compile.error.server", lang);
		case "cancelled":
			return t("compile.error.cancelled", lang);
		case "not_found":
			return t("compile.error.notFound", lang);
		case "unknown":
		default:
			return t("compile.error.unknown", lang, { msg: fallbackMsg });
	}
}

/** 无结构化 code 时，用消息子串做弱分类（兼容旧逻辑与 batch 里已字符串化的 reason） */
function inferFromErrorString(error: string): LLMErrorCode | undefined {
	const s = error.toLowerCase();
	if (s.includes("429") || s.includes("rate")) return "rate_limit";
	if (s.includes("401") || s.includes("403") || s.includes("invalid api key")) return "auth";
	if (s.includes("timeout") || s.includes("etimedout")) return "timeout";
	if (s.includes("network") || s.includes("econnrefused") || s.includes("fetch")) return "network";
	if (s.includes("context_length") || s.includes("maximum context") || s.includes("token")) return "context_length";
	if (s.includes("json") || s.includes("parse") || s.includes("sb_llm_no_content") || s.includes("choices[0]")) return "invalid_response";
	return undefined;
}

/** 单条编译失败详情（带可选 LLM 错误码） */
export function friendlyCompilePageError(lang: string, error: string, code?: LLMErrorCode): string {
	if (error.includes("empty") || error.includes("SB_EMPTY")) {
		return t("compile.error.rawEmpty", lang);
	}
	const effective = code != null && code !== "unknown" ? code : inferFromErrorString(error);
	if (effective) return messageFromCode(lang, effective, error);
	return t("compile.error.unknown", lang, { msg: error });
}

/** 任意 catch 到的值 → 用户可读一句（优先 LLMError.code） */
export function describeLLMFailure(lang: string, err: unknown): string {
	if (err instanceof LLMError) {
		return messageFromCode(lang, err.code, err.message);
	}
	const msg = err instanceof Error ? err.message : String(err);
	const inferred = inferFromErrorString(msg);
	if (inferred) return messageFromCode(lang, inferred, msg);
	return t("compile.error.unknown", lang, { msg });
}

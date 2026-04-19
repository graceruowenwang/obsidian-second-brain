// i18n -- 国际化：插件界面、LLM 输出、对话回复

import { zhCN } from "./zh-CN";
import { en } from "./en";
import { ja } from "./ja";

type Params = Record<string, string | number>;

export const LANG_INSTRUCTION: Record<string, string> = {
	"zh-CN": "用简体中文",
	"en": "Write in English",
	"ja": "日本語で記述してください",
};

const T: Record<string, Record<string, string>> = {
	"zh-CN": zhCN,
	"en": en,
	"ja": ja,
};

export function t(key: string, lang: string, params?: Params): string {
	const template = T[lang]?.[key] ?? T["zh-CN"]?.[key] ?? key;
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (_, k) =>
		String(params[k] ?? `{${k}}`)
	);
}

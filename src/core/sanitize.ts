// LLM 输出净化 — 过滤危险 HTML 标签和属性，防 XSS
// 注意：输入可能是整篇 Markdown，不能用 innerHTML 解析整串（会破坏 <https://...> 等语法）。

const DANGEROUS_TAGS = new Set([
	"script", "iframe", "object", "embed", "applet",
	"form", "input", "button", "select", "textarea",
	"link", "meta", "base", "noscript", "style",
]);

const SAFE_TAGS = new Set([
	"h1", "h2", "h3", "h4", "h5", "h6",
	"p", "br", "hr", "div", "span",
	"strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "sub", "sup",
	"ul", "ol", "li", "dl", "dt", "dd",
	"table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
	"a", "img", "figure", "figcaption",
	"blockquote", "pre", "code",
	"details", "summary",
	"abbr", "cite", "kbd", "var", "samp",
]);

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 成对 / 自闭合 / 落单 开合标签一并剥除，循环直到稳定（处理嵌套同名标签） */
function removeDangerousTagBlocks(content: string): string {
	let safe = content;
	for (const tag of DANGEROUS_TAGS) {
		const t = escapeRegExp(tag);
		const re = new RegExp(
			`<${t}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${t}\\s*>`  // paired block
			+ `|<${t}(?:\\s[^>]*)?/\\s*>`                   // self-closing
			+ `|<${t}(?:\\s[^>]*)?>`                        // open
			+ `|<\\/\\s*${t}\\s*>`,                         // close
			"gi",
		);
		let prev: string;
		do {
			prev = safe;
			safe = safe.replace(re, "");
		} while (safe !== prev);
	}
	return safe;
}

function stripEventHandlers(content: string): string {
	return content.replace(/\s+on[a-z][a-z0-9-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function neutralizeDangerousUrls(content: string): string {
	return content.replace(
		/(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
		(m, attr: string, dq?: string, sq?: string, bare?: string) => {
			const val = (dq ?? sq ?? bare ?? "").trim().toLowerCase();
			return /^(javascript|data|vbscript):/.test(val) ? `${attr}="#"` : m;
		},
	);
}

/**
 * 移除非白名单标签的整段标记（仅处理形如 `<tag ...>` / `</tag>` 的 token，避免误伤 `<https://...>`：
 * 要求标签名后紧跟空白、`>` 或 `/`，因此 `<https:` 不会匹配。
 */
function stripUnknownHtmlTags(safe: string): string {
	let out = safe;
	const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^>]*>/g;
	const matches: RegExpExecArray[] = [];
	let m: RegExpExecArray | null;
	re.lastIndex = 0;
	while ((m = re.exec(safe)) !== null) {
		const name = m[1].toLowerCase();
		if (!SAFE_TAGS.has(name) && !DANGEROUS_TAGS.has(name)) {
			matches.push(m);
		}
	}
	for (const match of matches.reverse()) {
		out = out.slice(0, match.index) + out.slice(match.index + match[0].length);
	}
	return out;
}

export function sanitizeLLMOutput(content: string): string {
	let safe = removeDangerousTagBlocks(content);
	safe = stripEventHandlers(safe);
	safe = neutralizeDangerousUrls(safe);
	safe = stripUnknownHtmlTags(safe);
	return safe;
}

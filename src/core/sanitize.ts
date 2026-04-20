// LLM 输出净化 — 过滤危险 HTML 标签和属性，防 XSS

const DANGEROUS_TAGS = new Set([
	"script", "iframe", "object", "embed", "applet",
	"form", "input", "button", "select", "textarea",
	"link", "meta", "base", "noscript",
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

const ON_EVENT_RE = /\s+on\w+\s*=/gi;

export function sanitizeLLMOutput(content: string): string {
	let safe = content;

	// 移除危险标签及其内容
	for (const tag of DANGEROUS_TAGS) {
		const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
		const closeRe = new RegExp(`</${tag}>`, "gi");
		safe = safe.replace(openRe, "").replace(closeRe, "");
	}

	// 移除 on* 事件属性
	safe = safe.replace(ON_EVENT_RE, " data-removed=");

	// 移除 javascript: / data: / vbscript: 协议的 href/src
	safe = safe.replace(
		/(href|src)\s*=\s*["']?\s*(javascript|data|vbscript)\s*:[^"'>\s]*/gi,
		'$1="#"'
	);

	// 保留未知标签但 strip 非白名单标签的属性（保守策略：只保留白名单标签的全部内容）
	for (const match of safe.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
		const fullMatch = match[0];
		const tagName = match[1].toLowerCase();
		if (!SAFE_TAGS.has(tagName) && !DANGEROUS_TAGS.has(tagName)) {
			safe = safe.replace(fullMatch, "");
		}
	}

	return safe;
}

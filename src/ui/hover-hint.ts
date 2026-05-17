// 统一使用 Obsidian setTooltip 提供 hover 提示，aria-label 保证无障碍访问

import { setTooltip, type TooltipPlacement } from "obsidian";
import { t } from "../core/i18n";

export function bindHoverHint(
	el: HTMLElement,
	text: string,
	options?: { placement?: TooltipPlacement },
): void {
	const placement: TooltipPlacement = options?.placement ?? "bottom";
	el.setAttribute("aria-label", text);
	setTooltip(el, text, { delay: 0, placement });
}

/**
 * 扫描容器内所有带 data-tooltip-key 属性的元素，自动绑定 i18n 提示。
 * 用法：<button data-tooltip-key="compile.tooltip.start">Start</button>
 */
export function autoBindHoverHints(container: HTMLElement, lang: string): void {
	container.querySelectorAll("[data-tooltip-key]").forEach((el) => {
		const key = el.getAttribute("data-tooltip-key");
		if (!key) return;
		const text = t(key, lang);
		if (text === key) return; // 未翻译，跳过
		bindHoverHint(el as HTMLElement, text);
	});
}

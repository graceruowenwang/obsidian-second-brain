// 侧栏等场景下仅 setTooltip 可能不明显：叠加原生 title 保证桌面端可见

import { setTooltip, type TooltipPlacement } from "obsidian";

export function bindHoverHint(
	el: HTMLElement,
	text: string,
	options?: { placement?: TooltipPlacement },
): void {
	const placement: TooltipPlacement = options?.placement ?? "bottom";
	el.setAttribute("aria-label", text);
	setTooltip(el, text, { delay: 0, placement });
	el.title = text;
}

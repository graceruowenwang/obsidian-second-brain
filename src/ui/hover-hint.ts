// 统一使用 Obsidian setTooltip 提供 hover 提示，aria-label 保证无障碍访问

import { setTooltip, type TooltipPlacement } from "obsidian";

export function bindHoverHint(
	el: HTMLElement,
	text: string,
	options?: { placement?: TooltipPlacement },
): void {
	const placement: TooltipPlacement = options?.placement ?? "bottom";
	el.setAttribute("aria-label", text);
	setTooltip(el, text, { delay: 0, placement });
}

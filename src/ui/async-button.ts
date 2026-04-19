// 异步按钮状态管理 — 统一 loading/success/fail 反馈

export function setAsyncButton(btn: HTMLButtonElement, loading: boolean, text?: string): void {
	btn.disabled = loading;
	if (loading) {
		btn.classList.add("sb-btn-loading");
		btn.textContent = text ?? "...";
	} else {
		btn.classList.remove("sb-btn-loading");
		if (text) btn.textContent = text;
	}
}

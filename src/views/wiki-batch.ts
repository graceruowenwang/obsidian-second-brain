// 批量审核功能 -- 从 wiki-view.ts 拆分

import { Modal, Notice } from "obsidian";
import { t } from "../core/i18n";
import type { WikiViewCtx } from "./wiki-shared";

export function toggleBatchReview(
	ctx: WikiViewCtx,
	btn: HTMLButtonElement | null,
	batchBar: HTMLElement | null,
	selectedPages: Set<string>,
): { batchMode: boolean; batchBar: HTMLElement | null } {
	const lang = ctx.plugin.settings.language;

	// 已经在批量模式 -> 退出
	if (batchBar && batchBar.isConnected) {
		exitBatchMode(batchBar, selectedPages, btn, lang);
		return { batchMode: false, batchBar: null };
	}

	// 清理残留状态
	selectedPages.clear();
	cleanupCheckboxes(ctx.bodyEl);

	// 进入批量模式
	if (btn) btn.textContent = t("wiki.batchReview", lang) + " *";

	const newBar = ctx.bodyEl.createDiv({ cls: "sb-batch-bar" });

	// 全选
	const selectAllCb = newBar.createEl("input", { attr: { type: "checkbox" }, cls: "sb-batch-select-all" });
	newBar.createEl("span", { text: t("wiki.selectAll", lang) });

	// 计数
	const countEl = newBar.createEl("span", { text: "0", cls: "sb-batch-count" });

	// 审核按钮
	const applyBtn = newBar.createEl("button", { text: t("wiki.batchReviewBtn", lang, { n: 0 }), cls: "mod-cta sb-batch-apply-btn" });
	applyBtn.disabled = true;

	// 批量重新生成按钮
	const regenBtn = newBar.createEl("button", { text: t("wiki.batchRegenBtn", lang, { n: 0 }), cls: "sb-batch-apply-btn" });
	regenBtn.disabled = true;

	// 取消按钮
	const cancelBtn = newBar.createEl("button", { text: t("set.cancel", lang), cls: "sb-batch-cancel-btn" });

	const rows = ctx.bodyEl.querySelectorAll<HTMLElement>(".sb-wiki-list-row[data-name]");
	if (rows.length === 0) {
		new Notice(t("wiki.batchNoRows", lang));
		if (btn) btn.textContent = t("wiki.batchReview", lang);
		return { batchMode: false, batchBar: null };
	}

	const rowCheckboxes: HTMLInputElement[] = [];

	rows.forEach((rowEl) => {
		const name = rowEl.dataset.name || "";
		if (!name) return;
		const key = rowEl.dataset.path || name;

		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.className = "sb-batch-checkbox";
		rowEl.insertBefore(checkbox, rowEl.firstChild);
		rowCheckboxes.push(checkbox);

		checkbox.addEventListener("click", (e) => e.stopPropagation());
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) {
				selectedPages.add(key);
			} else {
				selectedPages.delete(key);
			}
			updateCount();
		});
	});

	function updateCount() {
		const n = selectedPages.size;
		countEl.textContent = `${n}`;
		applyBtn.textContent = t("wiki.batchReviewBtn", lang, { n });
		applyBtn.disabled = n === 0;
		regenBtn.textContent = t("wiki.batchRegenBtn", lang, { n });
		regenBtn.disabled = n === 0;
		selectAllCb.checked = n === rows.length && rows.length > 0;
	}

	selectAllCb.addEventListener("change", () => {
		const checked = selectAllCb.checked;
		rowCheckboxes.forEach(cb => { cb.checked = checked; });
		selectedPages.clear();
		if (checked) {
			rows.forEach((rowEl) => {
				const n = rowEl.dataset.name;
				if (!n) return;
				selectedPages.add(rowEl.dataset.path || n);
			});
		}
		updateCount();
	});

	// 确认审核
	applyBtn.addEventListener("click", async () => {
		const count = selectedPages.size;
		if (count === 0) return;

		const confirmed = await new Promise<boolean>((resolve) => {
			const modal = new Modal(ctx.app);
			modal.titleEl.setText(t("wiki.batchConfirmTitle", lang));
			modal.contentEl.createEl("p", { text: t("wiki.batchConfirmDesc", lang, { n: count }) });
			const btnRow = modal.contentEl.createDiv();
			btnRow.style.display = "flex";
			btnRow.style.gap = "8px";
			btnRow.style.justifyContent = "flex-end";
			btnRow.createEl("button", { text: t("set.cancel", lang) }).addEventListener("click", () => { modal.close(); resolve(false); });
			btnRow.createEl("button", { text: t("wiki.batchConfirmBtn", lang), cls: "mod-cta" }).addEventListener("click", () => { modal.close(); resolve(true); });
			modal.open();
		});
		if (!confirmed) return;

		applyBtn.disabled = true;
		applyBtn.textContent = "...";
		for (const target of selectedPages) {
			await ctx.markAsReviewed(target);
		}

		exitBatchMode(newBar, selectedPages, btn, lang);
		await ctx.loadWiki();
		ctx.renderIndex();
	});

	// 批量重新生成
	regenBtn.addEventListener("click", async () => {
		const count = selectedPages.size;
		if (count === 0) return;
		regenBtn.disabled = true;
		regenBtn.textContent = "...";
		for (const target of selectedPages) {
			await ctx.markForRegeneration(target);
		}
		exitBatchMode(newBar, selectedPages, btn, lang);
		await ctx.loadWiki();
		ctx.renderIndex();
	});

	// 取消
	cancelBtn.addEventListener("click", () => {
		exitBatchMode(newBar, selectedPages, btn, lang);
	});

	return { batchMode: true, batchBar: newBar };
}

function exitBatchMode(bar: HTMLElement, selected: Set<string>, btn: HTMLButtonElement | null, lang: string) {
	selected.clear();
	bar.remove();
	if (btn) btn.textContent = t("wiki.batchReview", lang);
}

function cleanupCheckboxes(bodyEl: HTMLElement) {
	bodyEl.querySelectorAll(".sb-batch-checkbox").forEach(el => el.remove());
}

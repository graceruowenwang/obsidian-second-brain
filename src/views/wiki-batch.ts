// 批量审核功能 -- 从 wiki-view.ts 拆分

import { Modal } from "obsidian";
import { t } from "../core/i18n";
import type { WikiViewCtx } from "./wiki-shared";
import { setAsyncButton } from "../ui/async-button";

export function toggleBatchReview(ctx: WikiViewCtx, btn: HTMLButtonElement, batchBar: HTMLElement | null, selectedPages: Set<string>): { batchMode: boolean; batchBar: HTMLElement | null } {
	const lang = ctx.plugin.settings.language;
	if (ctx.currentView === "index" && batchBar) {
		// Already in batch mode -> exit
		selectedPages.clear();
		batchBar.remove();
		btn.textContent = t("wiki.batchReview", lang);
		return { batchMode: false, batchBar: null };
	}

	selectedPages.clear();
	btn.textContent = t("wiki.batchReview", lang) + " *";

	if (batchBar) batchBar.remove();
	const newBar = ctx.bodyEl.createDiv({ cls: "sb-batch-bar" });

	// Issue #5: select all checkbox
	const selectAllCb = newBar.createEl("input", { attr: { type: "checkbox" }, cls: "sb-batch-checkbox" });
	selectAllCb.addEventListener("change", () => {
		const checked = (selectAllCb as HTMLInputElement).checked;
		ctx.bodyEl.querySelectorAll(".sb-batch-checkbox").forEach((cb: HTMLInputElement) => {
			if (cb !== selectAllCb) { cb.checked = checked; cb.dispatchEvent(new Event("change")); }
		});
	});

	const countEl = newBar.createEl("span", { text: "0" });
	const applyBtn = newBar.createEl("button", { text: t("wiki.batchReviewBtn", lang, { n: 0 }), cls: "mod-cta" });

	// Issue #5: confirmation modal before batch review
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
			btnRow.createEl("button", { text: t("wiki.back", lang).replace("< ", "") }).addEventListener("click", () => { modal.close(); resolve(false); });
			btnRow.createEl("button", { text: t("wiki.batchConfirmBtn", lang), cls: "mod-cta" }).addEventListener("click", () => { modal.close(); resolve(true); });
			modal.open();
		});
		if (!confirmed) return;

		setAsyncButton(applyBtn, true);
		for (const name of selectedPages) {
			await ctx.markAsReviewed(name);
		}
		selectedPages.clear();
		newBar.remove();
		btn.textContent = t("wiki.batchReview", lang);
	});

	ctx.bodyEl.querySelectorAll(".sb-wiki-card").forEach((cardEl: HTMLElement) => {
		const titleLink = cardEl.querySelector(".sb-wiki-card-title") as HTMLAnchorElement;
		if (!titleLink) return;
		const name = titleLink.textContent || "";
		const checkbox = cardEl.createEl("input", { cls: "sb-batch-checkbox", attr: { type: "checkbox" } });
		checkbox.addEventListener("change", () => {
			if ((checkbox as HTMLInputElement).checked) {
				selectedPages.add(name);
			} else {
				selectedPages.delete(name);
			}
			countEl.textContent = `${selectedPages.size}`;
			applyBtn.textContent = t("wiki.batchReviewBtn", lang, { n: selectedPages.size });
		});
	});

	return { batchMode: true, batchBar: newBar };
}

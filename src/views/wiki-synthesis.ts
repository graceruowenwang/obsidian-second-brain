// 综合分析对话框 -- 从 wiki-view.ts 拆分

import { Modal, Notice } from "obsidian";
import { callLLM } from "../core/llm";
import { writeWikiFile } from "../core/file-utils";
import { t } from "../core/i18n";
import type { WikiViewCtx } from "./wiki-shared";
import { setAsyncButton } from "../ui/async-button";

export function openSynthesisDialog(ctx: WikiViewCtx): void {
	const lang = ctx.plugin.settings.language;
	const concepts = ctx.wikiPages
		.filter((f: { path: string }) => f.path.includes("concepts/"))
		.map((f: { path: string; content: string }) => ({ name: f.path.split("/").pop()!.replace(".md", ""), content: f.content }));

	const modal = new Modal(ctx.app);
	modal.titleEl.setText(t("wiki.synthSelect", lang));
	const container = modal.contentEl.createDiv();

	// Issue #4: search filter
	const searchEl = container.createEl("input", {
		attr: { placeholder: t("wiki.synthSearch", lang), type: "text" },
		cls: "sb-wiki-search",
	});

	// Toolbar: select all + counter
	const toolbar = container.createDiv({ cls: "sb-synth-toolbar" });
	const selectAllBtn = toolbar.createEl("button", { text: t("wiki.synthSelectAll", lang), cls: "sb-synth-select-all" });
	const counterEl = toolbar.createEl("span", { text: t("wiki.synthCounter", lang, { n: 0 }), cls: "sb-synth-counter" });

	const listEl = container.createDiv({ cls: "sb-synth-list" });
	const checkboxes: Array<{ name: string; el: HTMLInputElement; label: HTMLLabelElement }> = [];

	for (const c of concepts) {
		const label = listEl.createEl("label", { cls: "sb-synth-checkbox" });
		const cb = label.createEl("input", { attr: { type: "checkbox", value: c.name } });
		label.createSpan({ text: c.name });
		checkboxes.push({ name: c.name, el: cb, label });
	}

	const updateCounter = () => {
		const count = checkboxes.filter(c => c.el.checked).length;
		counterEl.textContent = t("wiki.synthCounter", lang, { n: count });
	};
	checkboxes.forEach(c => c.el.addEventListener("change", updateCounter));

	// Search filter logic
	searchEl.addEventListener("input", () => {
		const q = searchEl.value.toLowerCase();
		for (const c of checkboxes) {
			c.label.classList.toggle("sb-hidden", !c.name.toLowerCase().includes(q));
		}
	});

	// Select all toggle
	selectAllBtn.addEventListener("click", () => {
		const allChecked = checkboxes.filter(c => !c.label.classList.contains("sb-hidden")).every(c => c.el.checked);
		checkboxes.filter(c => !c.label.classList.contains("sb-hidden")).forEach(c => { c.el.checked = !allChecked; });
		updateCounter();
	});

	// Error display element
	const errorEl = container.createDiv({ cls: "sb-synth-error" });
	errorEl.classList.add("sb-hidden");

	const btnRow = container.createDiv({ cls: "sb-wizard-btn-row" });
	const genBtn = btnRow.createEl("button", { text: t("wiki.generate", lang), cls: "mod-cta" });
	genBtn.addEventListener("click", () => {
		void (async () => {
		const selected = checkboxes.filter(c => c.el.checked).map(c => c.name);
		if (selected.length < 2) {
			errorEl.textContent = t("wiki.synthSelectMin", lang);
			errorEl.classList.remove("sb-hidden");
			return;
		}
		errorEl.classList.add("sb-hidden");
		setAsyncButton(genBtn, true);
		try {
			const relatedContent = selected.map(n => {
				const page = concepts.find(c => c.name === n);
				return page ? `=== ${n} ===\n${page.content.slice(0, 1500)}` : "";
			}).join("\n\n");
			const today = new Date().toISOString().split("T")[0];
			const result = await callLLM([
				{ role: "system", content: "Knowledge synthesis expert. Write a cross-concept analysis in the same language as the source material." },
				{ role: "user", content: `Analyze the deep connections between these concepts: ${selected.join(", ")}\n\n${relatedContent.slice(0, 12000)}\n\nWrite a synthesis page answering: How do these concepts relate, complement, or contradict each other?` },
			], ctx.plugin.settings, { maxTokens: 3000, temperature: 0.5 });
			const slug = selected.join("-").slice(0, 60);
			const page = `---\ntitle: "${slug}"\ntype: synthesis\nstatus: "draft"\nlast_updated: ${today}\n---\n\n${result.trim()}\n`;
			await writeWikiFile(ctx.app, ctx.plugin.settings.wikiFolder, `syntheses/${slug}.md`, page);
			modal.close();
			new Notice(t("wiki.synthDone", lang));
			await ctx.loadWiki();
		} catch (_e) {
			setAsyncButton(genBtn, false, t("wiki.generateFailed", lang));
		}
		})();
	});
	modal.open();
}

// MOC (Map of Content) 管理 -- 从 wiki-view.ts 拆分

import { Notice } from "obsidian";
import { callLLM } from "../core/llm";
import { writeWikiFile } from "../core/file-utils";
import { t } from "../core/i18n";
import type { WikiViewCtx } from "./wiki-shared";

export async function showMoc(ctx: WikiViewCtx): Promise<void> {
	ctx.currentView = "index";
	ctx.currentName = "";
	ctx.navHistory = [];
	ctx.indexBtn.classList.remove("active");
	ctx.indexBtn.parentElement?.querySelectorAll(".sb-wiki-view-btn").forEach(b => b.classList.remove("active"));
	ctx.bodyEl.empty();

	const lang = ctx.plugin.settings.language;
	const mocPages = ctx.wikiPages.filter(f => {
		const fmMatch = f.content.match(/^---\n[\s\S]*?\n---/);
		return fmMatch && /^type:\s*["']?moc["']?/m.test(fmMatch[0]);
	});

	ctx.bodyEl.createEl("h2", { text: t("wiki.mocTitle", lang), cls: "sb-wiki-h2" });
	ctx.bodyEl.createEl("p", { text: t("wiki.mocDesc", lang), cls: "sb-wiki-card-desc" });

	const btnRow = ctx.bodyEl.createDiv({ cls: "sb-moc-btn-row" });
	btnRow.style.display = "flex";
	btnRow.style.gap = "8px";
	btnRow.style.marginBottom = "16px";

	const aiBtn = btnRow.createEl("button", { text: t("wiki.mocGenerate", lang), cls: "sb-empty-btn mod-cta" });
	aiBtn.addEventListener("click", async () => {
		aiBtn.textContent = t("wiki.mocGenerating", lang);
		aiBtn.setAttribute("disabled", "true");
		try {
			await generateMocWithAI(ctx);
			aiBtn.textContent = t("wiki.mocGenerated", lang);
			new Notice(t("wiki.mocGenerated", lang));
			await ctx.loadWiki();
			showMoc(ctx);
		} catch (e) {
			aiBtn.textContent = t("wiki.mocGenerateFail", lang);
			aiBtn.removeAttribute("disabled");
			new Notice(t("wiki.mocGenerateFail", lang) + ": " + (e instanceof Error ? e.message : String(e)));
		}
	});

	if (mocPages.length === 0) {
		ctx.bodyEl.createEl("p", { text: t("wiki.mocEmptyHint", lang), cls: "sb-wiki-empty" });
		return;
	}

	const list = ctx.bodyEl.createDiv({ cls: "sb-wiki-list sb-wiki-list-moc" });
	for (const page of mocPages) {
		const name = page.path.split("/").pop()!.replace(".md", "");
		const row = list.createDiv({
			cls: "sb-wiki-list-row sb-wiki-list-row-moc",
			attr: { "data-name": name, role: "button", tabindex: "0" },
		});
		row.addEventListener("click", () => ctx.navigateTo(name));
		row.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				ctx.navigateTo(name);
			}
		});
		row.createDiv({ cls: "sb-wiki-list-kind sb-wiki-list-kind-moc", text: t("wiki.mocShort", lang) });
		const main = row.createDiv({ cls: "sb-wiki-list-main" });
		const fmTitle = page.content.match(/^title:\s*["']?(.+?)["']?\s*$/m);
		main.createEl("div", { text: fmTitle ? fmTitle[1] : name, cls: "sb-wiki-list-title" });
		const stripped = page.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
		const firstLine = stripped.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith(">")) || "";
		if (firstLine) main.createEl("div", { cls: "sb-wiki-list-desc", text: firstLine.slice(0, 160) });
	}
}

async function generateMocWithAI(ctx: WikiViewCtx): Promise<void> {
	const wf = ctx.plugin.settings.wikiFolder;

	const pageSummaries = ctx.wikiPages
		.filter(f => f.path !== "index.md" && !f.path.endsWith("/index.md") && !f.path.endsWith("/log.md"))
		.map(f => {
			const name = f.path.split("/").pop()!.replace(".md", "");
			const type = ctx.extractType(f.content);
			const level = ctx.extractLevel(f.content);
			const tags = ctx.extractTags(f.content);
			const stripped = f.content.replace(/^---\n[\s\S]*?\n---\n*/, "");
			const firstLine = stripped.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith(">")) || "";
			return `- ${name} (type: ${type || "unknown"}, level: ${level || "unknown"}, tags: ${tags.join(",")}) — ${firstLine.slice(0, 100)}`;
		});

	if (pageSummaries.length === 0) {
		throw new Error("Wiki 中没有页面，无法生成 MOC");
	}

	const today = new Date().toISOString().split("T")[0];

	const result = await callLLM([
		{
			role: "system",
			content: `You are a knowledge management expert. Generate a Map of Content (MOC) page for a wiki.

A MOC is a navigational hub that:
1. Identifies thematic clusters among wiki pages
2. Creates structured reading paths for each cluster
3. Links all related pages using [[PageName]] wikilinks
4. Shows relationships between concepts

Output format:
- Start with YAML frontmatter: title, type: moc, status: "reviewed", last_updated
- Use Markdown with proper heading hierarchy
- Use [[PageName]] for all page references
- Group pages into thematic sections with clear headings
- Include a brief description after each wikilink
- Write in the same language as the source material`,
		},
		{
			role: "user",
			content: `Generate a comprehensive MOC for this wiki. Identify main themes and create a navigational structure.

Wiki pages:
${pageSummaries.join("\n")}

Output ONLY the complete MOC content starting with --- frontmatter.`,
		},
	], ctx.plugin.settings, { maxTokens: 4000, temperature: 0.4 });

	let page = result.trim();
	// 确保 frontmatter 存在且完整
	if (!page.startsWith("---")) {
		page = `---\ntitle: "Auto MOC ${today}"\ntype: moc\nstatus: "reviewed"\nlast_updated: ${today}\n---\n\n${page}`;
	}
	const slug = "moc-auto-" + today;
	await writeWikiFile(ctx.app, wf, `concepts/MOC/${slug}.md`, page);
}

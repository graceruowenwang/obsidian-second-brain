// License 设置 UI — 所有功能免费开源，仅展示状态

import { Setting } from "obsidian";
import type SecondBrain from "../main";
import { t } from "../core/i18n";

export function renderLicenseSettings(containerEl: HTMLElement, plugin: SecondBrain): void {
	const lang = plugin.settings.language;

	const section = containerEl.createEl("details", { cls: "sb-settings-section", attr: { open: "" } });
	section.createEl("summary", { text: t("license.sectionTitle", lang) });
	const content = section.createDiv({ cls: "sb-license-section" });

	const banner = content.createDiv({ cls: "sb-beta-banner" });
	banner.createDiv({ text: lang === "zh-CN" ? "所有功能免费开源" : "All features are free and open source", cls: "sb-beta-banner-title" });
	banner.createDiv({ text: lang === "zh-CN" ? "无需激活码，所有功能对所有用户开放。" : "No activation key needed. All features are available to everyone.", cls: "sb-beta-banner-desc" });

	const statusRow = content.createDiv({ cls: "sb-license-status" });
	statusRow.createSpan({ cls: "sb-license-dot sb-license-dot-ok" });
	statusRow.createSpan({ text: lang === "zh-CN" ? "所有功能已解锁" : "All features unlocked", cls: "sb-license-status-text" });

	new Setting(content)
		.setName(lang === "zh-CN" ? "LLM 提供商" : "LLM Provider")
		.setDesc(lang === "zh-CN" ? "在上方设置中配置 API Key 即可开始使用 AI 功能。" : "Configure your API key in the settings above to start using AI features.");
}

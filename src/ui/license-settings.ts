// License 设置 UI — 所有功能免费开放，仅展示状态信息

import { Setting } from "obsidian";
import type SecondBrain from "../main";
import { t } from "../core/i18n";
import { BETA_MODE } from "../core/license";

export function renderLicenseSettings(containerEl: HTMLElement, plugin: SecondBrain): void {
	const lang = plugin.settings.language;

	const section = containerEl.createEl("details", { cls: "sb-settings-section", attr: { open: "" } });
	section.createEl("summary", { text: t("license.sectionTitle", lang) });
	const content = section.createDiv({ cls: "sb-license-section" });

	// 免费横幅
	const banner = content.createDiv({ cls: "sb-beta-banner" });
	banner.createDiv({ text: BETA_MODE ? "All features are free and open source" : "所有功能免费开源", cls: "sb-beta-banner-title" });
	banner.createDiv({ text: BETA_MODE ? "No activation key needed. All features are available to everyone." : "无需激活码，所有功能对所有用户开放。", cls: "sb-beta-banner-desc" });

	// 简单的状态显示
	const statusRow = content.createDiv({ cls: "sb-license-status" });
	statusRow.createSpan({ cls: "sb-license-dot sb-license-dot-ok" });
	statusRow.createSpan({ text: BETA_MODE ? "All features unlocked" : "所有功能已解锁", cls: "sb-license-status-text" });

	// API Key 配置提示
	new Setting(content)
		.setName(BETA_MODE ? "LLM Provider" : "LLM 提供商")
		.setDesc(BETA_MODE ? "Configure your API key in the settings above to start using AI features." : "在上方设置中配置 API Key 即可开始使用 AI 功能。");
}

// 功能门控模块 — Free / Pro 功能分层

import { Modal, App } from "obsidian";
import type { LicenseInfo } from "../types";
import { openPluginSettings } from "../types";
import { isPro } from "./license";
import { t } from "./i18n";

export type FeatureId =
	| "auto-compile"
	| "ai-chat"
	| "multi-llm"
	| "health-check"
	| "advanced-templates"
	| "embedding-config";

const PRO_FEATURES: Set<FeatureId> = new Set([
	"auto-compile",
	"ai-chat",
	"multi-llm",
	"health-check",
]);

export function requirePro(state: LicenseInfo, featureId: FeatureId): boolean {
	if (!PRO_FEATURES.has(featureId)) return true;
	return isPro(state);
}

export function createProBadge(container: HTMLElement, lang: string): void {
	const badge = container.createEl("span", {
		text: t("license.proBadge", lang),
		cls: "sb-pro-badge",
	});
	badge.setAttribute("title", t("license.proBadgeTitle", lang));
}

export class UpgradeModal extends Modal {
	private featureId: FeatureId;
	private lang: string;

	constructor(app: App, featureId: FeatureId, lang: string) {
		super(app);
		this.featureId = featureId;
		this.lang = lang;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("sb-upgrade-modal");

		contentEl.createEl("h2", { text: t("license.upgradeTitle", this.lang) });
		contentEl.createEl("p", {
			text: t("license.upgradeDesc", this.lang, { feature: this.featureId }),
		});

		const priceEl = contentEl.createDiv({ cls: "sb-upgrade-pricing" });
		priceEl.createEl("span", { text: "30 CNY / $5 USD one-time", cls: "sb-upgrade-price" });

		const btnRow = contentEl.createDiv({ cls: "sb-upgrade-btns" });

		const upgradeBtn = btnRow.createEl("button", {
			text: t("license.upgradeBtn", this.lang),
			cls: "mod-cta",
		});
		upgradeBtn.addEventListener("click", () => {
			(window as any).open(t("license.purchaseUrl", this.lang));
		});

		const keyBtn = btnRow.createEl("button", {
			text: t("license.enterKey", this.lang),
		});
		keyBtn.addEventListener("click", () => {
			this.close();
			openPluginSettings(this.app);
		});

		const closeBtn = btnRow.createEl("button", {
			text: t("license.close", this.lang),
		});
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose() {
		this.contentEl.empty();
	}
}

export function showUpgradeNotice(app: App, featureId: FeatureId, lang: string): void {
	new UpgradeModal(app, featureId, lang).open();
}

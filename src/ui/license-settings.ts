// License 设置 UI -- 在设置面板中渲染 License 管理区域

import { Notice, Setting } from "obsidian";
import type SecondBrain from "../main";
import { DEFAULT_LICENSE, type LicenseInfo } from "../types";
import { t } from "../core/i18n";
import { validateLicense, activateLicense, activateByOrder, deactivateLicense, isPro, getTrialDaysLeft, isTrialActive } from "../core/license";

const COMPARE_FEATURES = [
	"manualCompile", "wikiBrowse", "deepseek",
	"autoCompile", "aiChat", "mindMap", "multiLlm",
	"templates", "embedding", "healthCheck",
] as const;

const FREE_FEATURES = new Set(["manualCompile", "wikiBrowse", "deepseek"]);

export function renderLicenseSettings(containerEl: HTMLElement, plugin: SecondBrain): void {
	const lang = plugin.settings.language;
	const state = plugin.licenseInfo;

	const section = containerEl.createEl("details", { cls: "sb-settings-section", attr: { open: "" } });
	section.createEl("summary", { text: t("license.sectionTitle", lang) });
	const content = section.createDiv({ cls: "sb-license-section" });

	// --- Free vs Pro 对比表 ---
	renderCompareTable(content, lang, state);

	// 状态显示
	const statusRow = content.createDiv({ cls: "sb-license-status" });
	const dotCls = state.status === "active" || state.status === "trial" ? "sb-license-dot-ok"
		: state.status === "grace" ? "sb-license-dot-warn"
		: "sb-license-dot-err";
	statusRow.createEl("span", { cls: `sb-license-dot ${dotCls}` });
	const statusText = state.status === "active" ? t("license.statusActive", lang)
		: state.status === "trial" ? t("pro.trialActive", lang) + " (" + t("pro.trialDaysLeft", lang, { days: getTrialDaysLeft(state) }) + ")"
		: state.status === "grace" ? t("license.statusGrace", lang)
		: state.status === "expired" ? t("license.statusExpired", lang)
		: t("license.statusFree", lang);
	statusRow.createEl("span", { text: statusText, cls: "sb-license-status-text" });

	if (state.expiresAt) {
		const d = new Date(state.expiresAt).toLocaleDateString();
		statusRow.createEl("span", { text: t("license.expiresAt", lang, { date: d }), cls: "sb-license-expires" });
	}

	// 爱发电订单号激活（仅未激活时显示，放在最前面）
	if (!isPro(state)) {
		const orderSection = content.createDiv({ cls: "sb-license-order-section" });

		// 购买链接 + 订单激活
		const purchaseRow = orderSection.createDiv({ cls: "sb-license-purchase" });
		const purchaseLink = purchaseRow.createEl("a", {
			text: t("license.goBuy", lang),
			href: t("license.purchaseUrl", lang),
		});
		purchaseLink.setAttribute("target", "_blank");

		let orderInput: HTMLInputElement | null = null;
		new Setting(orderSection)
			.setName(t("license.orderLabel", lang))
			.setDesc(t("license.orderDesc", lang))
			.addText((text) => {
				text.setPlaceholder(t("license.orderPlaceholder", lang));
				orderInput = text.inputEl;
			})
			.addButton((btn) => {
				btn.setButtonText(t("license.orderActivate", lang));
				btn.setClass("mod-cta");
				btn.onClick(async () => {
					const orderId = orderInput?.value?.trim();
					if (!orderId) {
						new Notice(t("license.orderFail", lang));
						return;
					}
					btn.setDisabled(true);
					try {
						const instanceName = plugin.app.vault.getName();
						const { licenseInfo, licenseKey } = await activateByOrder(orderId, instanceName);
						plugin.licenseInfo = licenseInfo;
						plugin.settings.licenseKey = licenseKey;
						await plugin.saveSettings();
						await plugin.saveLicenseInfo();
						new Notice(t("license.orderSuccess", lang));
						plugin.refreshSettingsTab();
					} catch (e: unknown) {
						const msg = e instanceof Error ? e.message : String(e);
						if (msg?.includes("not found") || msg?.includes("not paid")) {
							new Notice(t("license.orderNotFound", lang));
						} else if (msg?.includes("Rate limit")) {
							new Notice(t("license.rateLimit", lang));
						} else {
							new Notice(t("license.orderFail", lang));
						}
					} finally {
						btn.setDisabled(false);
					}
				});
			});

		// 分隔线
		content.createEl("div", { cls: "sb-license-divider", text: t("license.orKey", lang) });
	}

	// License Key 输入
	new Setting(content)
		.setName(t("license.keyLabel", lang))
		.addText((text) => {
			text.setPlaceholder(t("license.keyPlaceholder", lang))
				.setValue(plugin.settings.licenseKey)
				.onChange(async (v) => {
					plugin.settings.licenseKey = v;
					await plugin.saveSettings();
				});
			text.inputEl.type = "password";
		});

	// 按钮行
	const btnRow = content.createDiv({ cls: "sb-license-btns" });

	const activateBtn = btnRow.createEl("button", { text: t("license.activate", lang), cls: "mod-cta" });
	activateBtn.addEventListener("click", async () => {
		const key = plugin.settings.licenseKey.trim();
		if (!key) {
			new Notice(t("license.activationFail", lang));
			return;
		}
		activateBtn.disabled = true;
		try {
			const result = await activateLicense(key);
			plugin.licenseInfo = result;
			await plugin.saveLicenseInfo();
			new Notice(t("license.activationSuccess", lang));
			plugin.refreshSettingsTab();
		} catch (e: unknown) {
			if ((e instanceof Error ? e.message : String(e))?.includes("Rate limit")) {
				new Notice(t("license.rateLimit", lang));
			} else {
				new Notice(t("license.activationFail", lang));
			}
		} finally {
			activateBtn.disabled = false;
		}
	});

	if (isPro(state)) {
		const deactivateBtn = btnRow.createEl("button", { text: t("license.deactivate", lang) });
		deactivateBtn.addEventListener("click", async () => {
			await deactivateLicense(state.key, state.instanceId);
			plugin.licenseInfo = { ...DEFAULT_LICENSE };
			plugin.settings.licenseKey = "";
			await plugin.saveSettings();
			await plugin.saveLicenseInfo();
			new Notice(t("license.statusFree", lang));
			plugin.refreshSettingsTab();
		});

		const validateBtn = btnRow.createEl("button", { text: t("license.validate", lang) });
		validateBtn.addEventListener("click", async () => {
			validateBtn.disabled = true;
			try {
				const result = await validateLicense(state.key, state.instanceId);
				plugin.licenseInfo = result;
				await plugin.saveLicenseInfo();
				new Notice(t("license.statusActive", lang));
				plugin.refreshSettingsTab();
			} catch (e) {
				console.warn("license-settings:", e);
				new Notice(t("license.networkError", lang));
			} finally {
				validateBtn.disabled = false;
			}
		});
	}

	// 试用提示
	if (isTrialActive(state)) {
		const days = getTrialDaysLeft(state);
		const trialNotice = content.createDiv({ cls: "sb-trial-notice" });
		trialNotice.createEl("span", { text: t("pro.trialDaysLeft", lang, { days }) });
	} else if (state.status === "none" || state.status === "inactive" || state.status === "expired") {
		if (!state.key) {
			const trialHint = content.createDiv({ cls: "sb-trial-hint" });
			trialHint.createEl("span", { text: t("pro.trialStarted", lang).split("!")[0] + " — " + t("pro.trialDaysLeft", lang, { days: 14 }) });
		}
	}

	// 购买链接
	if (!isPro(state)) {
		const linkRow = content.createDiv({ cls: "sb-license-purchase" });
		const link = linkRow.createEl("a", {
			text: t("license.getPro", lang),
			href: t("license.purchaseUrl", lang),
		});
		link.setAttribute("target", "_blank");
	}
}

function renderCompareTable(container: HTMLElement, lang: string, _state: LicenseInfo): void {
	const wrapper = container.createDiv({ cls: "sb-compare-table-wrap" });
	wrapper.createEl("div", { text: t("pro.compareTitle", lang), cls: "sb-compare-title" });

	const table = wrapper.createEl("table", { cls: "sb-compare-table" });

	const thead = table.createEl("thead");
	const headerRow = thead.createEl("tr");
	headerRow.createEl("th", { text: "" });
	headerRow.createEl("th", { text: t("pro.compareFree", lang) });
	headerRow.createEl("th", { text: t("pro.comparePro", lang), cls: "sb-compare-th-pro" });

	const tbody = table.createEl("tbody");
	for (const feat of COMPARE_FEATURES) {
		const tr = tbody.createEl("tr");
		const nameCell = tr.createEl("td");
		nameCell.createDiv({ text: t(`pro.compare.${feat}`, lang), cls: "sb-compare-feat-name" });
		nameCell.createDiv({ text: t(`pro.compare.${feat}Desc`, lang), cls: "sb-compare-feat-desc" });

		const freeCell = tr.createEl("td", { cls: "sb-compare-check" });
		freeCell.textContent = FREE_FEATURES.has(feat) ? "\u2713" : "";

		const proCell = tr.createEl("td", { cls: "sb-compare-check sb-compare-check-pro" });
		proCell.textContent = "\u2713";
	}
}

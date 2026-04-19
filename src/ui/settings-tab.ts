// 设置面板 -- Provider 切换确认 + 完整设置 Tab

import { App, Modal, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type SecondBrain from "../main";
import { DEFAULT_SETTINGS } from "../types";
import { readWikiFiles, emptyCache, clearEmbeddingCache } from "../core/file-utils";
import { callLLM } from "../core/llm";
import { t } from "../core/i18n";
import { PROVIDER_PRESETS } from "../core/presets";
import { renderLicenseSettings } from "./license-settings";
import { requirePro, showUpgradeNotice, createProBadge } from "../core/feature-gate";

// === Imp 10: Provider 切换确认 Modal ===
class ProviderSwitchModal extends Modal {
	private provider: string;
	private onConfirm: () => void;
	private lang: string;

	constructor(app: App, provider: string, lang: string, onConfirm: () => void) {
		super(app);
		this.provider = provider;
		this.lang = lang;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const label = PROVIDER_PRESETS[this.provider]?.label || this.provider;
		this.contentEl.createEl("h3", { text: t("set.providerSwitchTitle", this.lang) });
		this.contentEl.createEl("p", { text: t("set.providerSwitchDesc", this.lang, { provider: label }) });

		const btnRow = this.contentEl.createDiv();
		btnRow.style.display = "flex";
		btnRow.style.gap = "8px";
		btnRow.style.justifyContent = "flex-end";

		const cancelBtn = btnRow.createEl("button", { text: t("set.cancel", this.lang) });
		cancelBtn.addEventListener("click", () => this.close());

		const switchBtn = btnRow.createEl("button", { text: t("set.switch", this.lang), cls: "mod-cta" });
		switchBtn.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});
	}
}

// === 设置面板 ===
export class SecondBrainSettingTab extends PluginSettingTab {
	plugin: SecondBrain;

	constructor(app: App, plugin: SecondBrain) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const lang = this.plugin.settings.language;

		containerEl.createEl("h2", { text: t("set.title", lang) });

		// --- License & Pro 区域（最顶部） ---
		renderLicenseSettings(containerEl, this.plugin);

		// --- Imp 2: 配置健康检查（Pro） ---
		if (requirePro(this.plugin.licenseInfo, "health-check")) {
			this.renderHealthBar(containerEl, lang);
		}

		// --- Imp 8: LLM 配置（必填） ---
		const reqDetails = containerEl.createEl("details", { cls: "sb-settings-section", attr: { open: "" } });
		reqDetails.createEl("summary", { text: t("set.sectionRequired", lang) });
		const reqContent = reqDetails.createDiv();

		// Imp 9: 快速配置
		new Setting(reqContent)
			.setName(t("preset.quickSetup", lang))
			.addDropdown((dd) => {
				dd.addOption("", "-- " + t("preset.quickSetup", lang) + " --");
				for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
					dd.addOption(key, preset.label);
				}
				dd.setValue("");
				dd.onChange(async (v) => {
					if (!v) return;
					// 非 DeepSeek 需要 Pro
					if (v !== "deepseek" && !requirePro(this.plugin.licenseInfo, "multi-llm")) {
						showUpgradeNotice(this.app, "multi-llm", lang);
						return;
					}
					const preset = PROVIDER_PRESETS[v];
					if (!preset) return;
					this.plugin.settings.provider = v;
					this.plugin.settings.baseUrl = preset.baseUrl;
					this.plugin.settings.model = preset.models[0];
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(reqContent)
			.setName(t("set.provider", lang))
			.addDropdown((dd) => dd
				.addOptions({ deepseek: "DeepSeek", openai: "OpenAI", anthropic: "Anthropic (Claude)", openrouter: "OpenRouter", custom: "Custom" })
				.setValue(this.plugin.settings.provider)
				.onChange(async (v) => {
					// 非 DeepSeek 需要 Pro
					if (v !== "deepseek" && !requirePro(this.plugin.licenseInfo, "multi-llm")) {
						showUpgradeNotice(this.app, "multi-llm", lang);
						return;
					}
					const oldProvider = this.plugin.settings.provider;
					if (v !== oldProvider) {
						// Imp 10: 切换确认
						new ProviderSwitchModal(this.app, v, lang, async () => {
							this.plugin.settings.provider = v;
							await this.plugin.saveSettings();
							this.display();
						}).open();
					}
				}));

		new Setting(reqContent)
			.setName(t("set.model", lang))
			.addDropdown((dd) => {
				const preset = PROVIDER_PRESETS[this.plugin.settings.provider];
				if (preset) {
					for (const m of preset.models) dd.addOption(m, m);
					dd.addOption("__custom", "(" + t("set.modelPh", lang) + ")");
					dd.setValue(preset.models.includes(this.plugin.settings.model) ? this.plugin.settings.model : "__custom");
				} else {
					dd.addOption(this.plugin.settings.model, this.plugin.settings.model);
				}
				dd.onChange(async (v) => {
					if (v !== "__custom") {
						this.plugin.settings.model = v;
						await this.plugin.saveSettings();
					}
				});
			})
			.addText((t2) => {
				const preset = PROVIDER_PRESETS[this.plugin.settings.provider];
				if (preset && preset.models.includes(this.plugin.settings.model)) {
					t2.inputEl.style.display = "none";
				} else {
					t2.setPlaceholder(t("set.modelPh", lang)).setValue(this.plugin.settings.model).onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); });
				}
			});

		const apiKeySetting = new Setting(reqContent)
			.setName(t("set.apiKey", lang))
			.setDesc(t("set.apiKeyDesc", lang))
			.addText((t2) => { t2.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey).onChange(async (v) => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }); t2.inputEl.type = "password"; });

		// apiKey 获取链接随 provider 变化
		const preset = PROVIDER_PRESETS[this.plugin.settings.provider];
		if (preset) {
			apiKeySetting.descEl.createEl("a", { text: t("set.getApiKey", lang), href: preset.keyUrl });
		}

		new Setting(reqContent)
			.setName(t("set.baseUrl", lang))
			.addText((t2) => t2.setPlaceholder(t("set.baseUrlPh", lang)).setValue(this.plugin.settings.baseUrl).onChange(async (v) => { this.plugin.settings.baseUrl = v; await this.plugin.saveSettings(); }));

		new Setting(reqContent)
			.setName(t("set.testConn", lang))
			.addButton((btn) => btn.setButtonText(t("set.test", lang)).onClick(async () => {
				try {
					const reply = await callLLM([{ role: "user", content: "Hi" }], this.plugin.settings, { maxTokens: 10, temperature: 0 });
					new Notice(t("notice.connOk", lang, { msg: reply }));
				} catch (e: unknown) {
					new Notice(t("notice.connFail", lang, { msg: (e instanceof Error ? e.message : String(e)) }));
				}
			}));

		// --- Imp 8: 推荐设置 ---
		const recDetails = containerEl.createEl("details", { cls: "sb-settings-section" });
		recDetails.createEl("summary", { text: t("set.sectionRecommended", lang) });
		const recContent = recDetails.createDiv();

		// 自动编译（Pro）— 带 PRO badge
		const autoCompileSetting = new Setting(recContent)
			.setName(t("set.autoCompile", lang))
			.setDesc(t("set.autoCompileDesc", lang));
		if (!requirePro(this.plugin.licenseInfo, "auto-compile")) {
			createProBadge(autoCompileSetting.nameEl, lang);
		}
		autoCompileSetting.addToggle((toggle) => toggle
			.setValue(this.plugin.settings.autoCompile)
			.setDisabled(!requirePro(this.plugin.licenseInfo, "auto-compile"))
			.onChange(async (v) => {
				if (!requirePro(this.plugin.licenseInfo, "auto-compile")) {
					showUpgradeNotice(this.app, "auto-compile", lang);
					return;
				}
				this.plugin.settings.autoCompile = v;
				await this.plugin.saveSettings();
			}));

		new Setting(recContent)
			.setName(t("set.delay", lang))
			.setDesc(t("set.delayDesc", lang))
			.addSlider((slider) => slider
				.setLimits(10, 120, 5)
				.setValue(this.plugin.settings.autoCompileDelay)
				.setDynamicTooltip()
				.onChange(async (v) => { this.plugin.settings.autoCompileDelay = v; await this.plugin.saveSettings(); }));

		new Setting(recContent)
			.setName(t("set.language", lang))
			.setDesc(t("set.languageDesc", lang))
			.addDropdown((dd) => dd
				.addOptions({ "zh-CN": "简体中文", "en": "English", "ja": "日本語" })
				.setValue(this.plugin.settings.language)
				.onChange(async (v) => { this.plugin.settings.language = v; await this.plugin.saveSettings(); this.display(); }));

		// 模板配置（Pro）
		const tplSetting = new Setting(recContent)
			.setName(t("set.tplFile", lang))
			.setDesc(t("set.tplFileDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.tplFilePh", lang)).setValue(this.plugin.settings.templateFile).onChange(async (v) => { this.plugin.settings.templateFile = v; await this.plugin.saveSettings(); }));
		if (!requirePro(this.plugin.licenseInfo, "advanced-templates")) {
			createProBadge(tplSetting.nameEl, lang);
		}

		const genTplSetting = new Setting(recContent)
			.setName(t("set.genTpl", lang))
			.setDesc(t("set.genTplDesc", lang))
			.addButton((btn) => btn.setButtonText(t("set.gen", lang)).onClick(async () => {
				if (!requirePro(this.plugin.licenseInfo, "advanced-templates")) {
					showUpgradeNotice(this.app, "advanced-templates", lang);
					return;
				}
				try {
					const { generateTemplateFile } = await import("../core/templates");
					await generateTemplateFile(this.app, this.plugin.settings.templateFile, this.plugin.settings.language);
					new Notice(t("notice.tplGenerated", lang, { path: this.plugin.settings.templateFile }));
				} catch (e: unknown) {
					new Notice(t("notice.tplFail", lang, { msg: (e instanceof Error ? e.message : String(e)) }));
				}
			}));
		if (!requirePro(this.plugin.licenseInfo, "advanced-templates")) {
			createProBadge(genTplSetting.nameEl, lang);
		}

		// --- Imp 8: 高级设置 ---
		const advDetails = containerEl.createEl("details", { cls: "sb-settings-section" });
		advDetails.createEl("summary", { text: t("set.sectionAdvanced", lang) });
		const advContent = advDetails.createDiv();

		// Embedding 配置（Pro）
		const embedHeader = advContent.createEl("h4", { text: t("set.embedSection", lang) });
		if (!requirePro(this.plugin.licenseInfo, "embedding-config")) {
			createProBadge(embedHeader, lang);
		}

		new Setting(advContent)
			.setName(t("set.embedModel", lang))
			.setDesc(t("set.embedModelDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.embedModelPh", lang)).setValue(this.plugin.settings.embeddingModel).onChange(async (v) => {
				if (!requirePro(this.plugin.licenseInfo, "embedding-config")) {
					showUpgradeNotice(this.app, "embedding-config", lang);
					return;
				}
				this.plugin.settings.embeddingModel = v;
				await this.plugin.saveSettings();
			}));

		new Setting(advContent)
			.setName(t("set.embedUrl", lang))
			.setDesc(t("set.embedUrlDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.embedUrlPh", lang)).setValue(this.plugin.settings.embeddingBaseUrl).onChange(async (v) => {
				if (!requirePro(this.plugin.licenseInfo, "embedding-config")) {
					showUpgradeNotice(this.app, "embedding-config", lang);
					return;
				}
				this.plugin.settings.embeddingBaseUrl = v;
				await this.plugin.saveSettings();
			}));

		new Setting(advContent)
			.setName(t("set.embedKey", lang))
			.setDesc(t("set.embedKeyDesc", lang))
			.addText((t2) => {
				t2.setPlaceholder("sk-...").setValue(this.plugin.settings.embeddingApiKey).onChange(async (v) => {
					if (!requirePro(this.plugin.licenseInfo, "embedding-config")) {
						showUpgradeNotice(this.app, "embedding-config", lang);
						return;
					}
					this.plugin.settings.embeddingApiKey = v;
					await this.plugin.saveSettings();
				});
				t2.inputEl.type = "password";
			});

		advContent.createEl("h4", { text: t("set.folderSection", lang) });

		new Setting(advContent)
			.setName(t("set.rawFolder", lang))
			.setDesc(t("set.rawFolderDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.rawFolderPh", lang)).setValue(this.plugin.settings.rawFolder).onChange(async (v) => { this.plugin.settings.rawFolder = v; await this.plugin.saveSettings(); }));

		new Setting(advContent)
			.setName(t("set.wikiFolder", lang))
			.setDesc(t("set.wikiFolderDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.wikiFolderPh", lang)).setValue(this.plugin.settings.wikiFolder).onChange(async (v) => { this.plugin.settings.wikiFolder = v; await this.plugin.saveSettings(); }));

		advContent.createEl("h4", { text: t("set.dataSection", lang) });

		new Setting(advContent)
			.setName(t("set.cleanWiki", lang))
			.setDesc(t("set.cleanWikiDesc", lang))
			.addButton((btn) => btn.setButtonText(t("set.cleanWikiBtn", lang)).setWarning().onClick(async () => {
				const modal = new Modal(this.app);
				modal.contentEl.createEl("h3", { text: t("set.confirmTitle", lang) });
				modal.contentEl.createEl("p", { text: t("set.confirmDesc", lang) });
				modal.contentEl.createEl("p", { text: t("set.confirmHint", lang) });
				const input = modal.contentEl.createEl("input", { type: "text", placeholder: t("set.confirmPh", lang) });

				const btnRow = modal.contentEl.createDiv();
				btnRow.style.display = "flex";
				btnRow.style.gap = "8px";
				btnRow.style.justifyContent = "flex-end";

				const cancelBtn = btnRow.createEl("button", { text: t("set.cancel", lang) });
				cancelBtn.addEventListener("click", () => modal.close());

				const confirmBtn = btnRow.createEl("button", { text: t("set.confirmBtn", lang), cls: "mod-warning" });
				confirmBtn.addEventListener("click", async () => {
					if (input.value !== "CONFIRM") {
						new Notice(t("notice.pleaseConfirm", lang));
						return;
					}
					confirmBtn.disabled = true;
					confirmBtn.textContent = t("set.cleaning", lang);
					try {
						const wikiFolder = this.plugin.settings.wikiFolder;
						const wikiFiles = await readWikiFiles(this.app, wikiFolder);
						for (const f of wikiFiles) {
							const fullPath = `${wikiFolder}/${f.path}`;
							const file = this.app.vault.getAbstractFileByPath(fullPath);
							if (file instanceof TFile) {
								await this.app.vault.delete(file);
							}
						}
						// 只重置 wiki/cache 相关状态，保留用户配置
						const s = this.plugin.settings;
						this.plugin.settings = {
							...DEFAULT_SETTINGS,
							provider: s.provider,
							model: s.model,
							apiKey: s.apiKey,
							baseUrl: s.baseUrl,
							maxTokens: s.maxTokens,
							temperature: s.temperature,
							embeddingProvider: s.embeddingProvider,
							embeddingModel: s.embeddingModel,
							embeddingBaseUrl: s.embeddingBaseUrl,
							embeddingApiKey: s.embeddingApiKey,
							language: s.language,
							licenseKey: s.licenseKey,
							proWelcomeShown: s.proWelcomeShown,
						};
						await this.plugin.saveData(emptyCache());
						new Notice(t("notice.wikiCleaned", lang, { n: wikiFiles.length }));
						modal.close();
					} catch (e: unknown) {
						new Notice(t("notice.cleanFail", lang, { msg: (e instanceof Error ? e.message : String(e)) }));
						confirmBtn.disabled = false;
						confirmBtn.textContent = t("set.confirmBtn", lang);
					}
				});
				modal.open();
			}));

		new Setting(advContent)
			.setName(t("set.cleanCache", lang))
			.setDesc(t("set.cleanCacheDesc", lang))
			.addButton((btn) => btn.setButtonText(t("set.cleanCacheBtn", lang)).setWarning().onClick(async () => {
				await this.plugin.saveData(emptyCache());
				clearEmbeddingCache();
				new Notice(t("notice.cacheCleaned", lang));
			}));
	}

	// --- Imp 2: 健康检查 ---
	private renderHealthBar(containerEl: HTMLElement, lang: string) {
		const bar = containerEl.createDiv({ cls: "sb-health-bar" });

		// API 状态
		const apiItem = bar.createDiv({ cls: "sb-health-item" });
		apiItem.createEl("span", { cls: "sb-health-dot sb-health-err" });
		apiItem.createEl("span", { text: t("health.apiFail", lang), cls: "sb-health-label" });
		if (this.plugin.settings.apiKey) {
			apiItem.querySelector(".sb-health-dot")?.classList.replace("sb-health-err", "sb-health-ok");
			apiItem.querySelector(".sb-health-label")?.setText(t("health.apiOk", lang));
		}

		// raw/ 目录
		const rawItem = bar.createDiv({ cls: "sb-health-item" });
		const rawFolder = this.plugin.settings.rawFolder;
		const rawExists = !!this.app.vault.getAbstractFileByPath(rawFolder);
		rawItem.createEl("span", { cls: `sb-health-dot ${rawExists ? "sb-health-ok" : "sb-health-err"}` });
		rawItem.createEl("span", { text: rawExists ? t("health.rawOk", lang) : t("health.rawFail", lang), cls: "sb-health-label" });

		// 编译状态
		const compileItem = bar.createDiv({ cls: "sb-health-item" });
		const wikiFolder = this.plugin.settings.wikiFolder;
		const wikiExists = !!this.app.vault.getAbstractFileByPath(wikiFolder);
		compileItem.createEl("span", { cls: `sb-health-dot ${wikiExists ? "sb-health-ok" : "sb-health-err"}` });
		compileItem.createEl("span", { text: wikiExists ? t("health.compiled", lang) : t("health.notCompiled", lang), cls: "sb-health-label" });

		// 刷新按钮
		const refreshBtn = bar.createEl("button", { text: t("health.refresh", lang), cls: "sb-health-refresh" });
		refreshBtn.addEventListener("click", () => this.display());
	}
}

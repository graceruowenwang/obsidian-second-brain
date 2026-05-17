// 设置面板 -- Provider 切换确认 + 完整设置 Tab

import { App, Modal, Notice, PluginSettingTab, Setting, TFile } from "obsidian";
import type SecondBrain from "../main";
import { DEFAULT_SETTINGS, type LLMProviderId, type UILanguageId } from "../types";
import { readWikiFiles, emptyCache, clearEmbeddingCache } from "../core/file-utils";
import { callLLM } from "../core/llm";
import { t } from "../core/i18n";
import { PROVIDER_PRESETS, providerPresetOrUndefined } from "../core/presets";
import { describeLLMFailure } from "../core/llm-user-message";

// === Imp 10: Provider 切换确认 Modal ===
class ProviderSwitchModal extends Modal {
	private provider: LLMProviderId;
	private onConfirm: () => void;
	private lang: string;

	constructor(app: App, provider: LLMProviderId, lang: string, onConfirm: () => void) {
		super(app);
		this.provider = provider;
		this.lang = lang;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const label = providerPresetOrUndefined(this.provider)?.label || this.provider;
		this.contentEl.createEl("h3", { text: t("set.providerSwitchTitle", this.lang) });
		this.contentEl.createEl("p", { text: t("set.providerSwitchDesc", this.lang, { provider: label }) });

		const btnRow = this.contentEl.createDiv();
		btnRow.classList.add("sb-flex-row-end");

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

		new Setting(containerEl).setName(t("set.title", lang)).setHeading();

		// --- 配置状态 ---
		const statusDetails = containerEl.createEl("details", { cls: "sb-settings-section", attr: { open: "" } });
		statusDetails.createEl("summary", { text: t("set.sectionStatus", lang) });
		this.renderHealthBar(statusDetails.createDiv(), lang);

		// --- LLM 连接 ---
		const reqDetails = containerEl.createEl("details", { cls: "sb-settings-section", attr: { open: "" } });
		reqDetails.createEl("summary", { text: t("set.sectionConnection", lang) });
		const reqContent = reqDetails.createDiv();

		// 快速配置
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
					const preset = PROVIDER_PRESETS[v as keyof typeof PROVIDER_PRESETS];
					if (!preset) return;
					this.plugin.settings.provider = v as LLMProviderId;
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
				.onChange((v) => {
					const oldProvider = this.plugin.settings.provider;
					if (v !== oldProvider) {
						new ProviderSwitchModal(this.app, v as LLMProviderId, lang, () => {
							void (async () => {
							this.plugin.settings.provider = v as LLMProviderId;
							await this.plugin.saveSettings();
							this.display();
							})();
						}).open();
					}
				}));

		new Setting(reqContent)
			.setName(t("set.model", lang))
			.addDropdown((dd) => {
				const preset = providerPresetOrUndefined(this.plugin.settings.provider);
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
				const preset = providerPresetOrUndefined(this.plugin.settings.provider);
				if (preset && preset.models.includes(this.plugin.settings.model)) {
					t2.inputEl.classList.add("sb-hidden");
				} else {
					t2.setPlaceholder(t("set.modelPh", lang)).setValue(this.plugin.settings.model).onChange(async (v) => { this.plugin.settings.model = v; await this.plugin.saveSettings(); });
				}
			});

		const apiKeySetting = new Setting(reqContent)
			.setName(t("set.apiKey", lang))
			.setDesc(t("set.apiKeyDesc", lang))
			.addText((t2) => { t2.setPlaceholder("Sk-...").setValue(this.plugin.settings.apiKey).onChange(async (v) => { this.plugin.settings.apiKey = v; await this.plugin.saveSettings(); }); t2.inputEl.type = "password"; });

		const preset = providerPresetOrUndefined(this.plugin.settings.provider);
		if (preset) {
			apiKeySetting.descEl.createEl("a", { text: t("set.getApiKey", lang), href: preset.keyUrl });
		}

		new Setting(reqContent)
			.setName(t("set.baseUrl", lang))
			.addText((t2) => t2.setPlaceholder(t("set.baseUrlPh", lang)).setValue(this.plugin.settings.baseUrl).onChange(async (v) => { this.plugin.settings.baseUrl = v; await this.plugin.saveSettings(); }));

		new Setting(reqContent)
			.setName(t("set.testConn", lang))
			.addButton((btn) => btn.setButtonText(t("set.test", lang)).onClick(() => {
				void (async () => {
				btn.setButtonText("...");
				const start = Date.now();
				try {
					await callLLM([{ role: "user", content: "Hi" }], this.plugin.settings, { maxTokens: 5, temperature: 0 });
					const ms = Date.now() - start;
					new Notice(t("notice.connOk", lang, { ms: ms < 1000 ? `${ms}ms` : `${(ms/1000).toFixed(1)}s` }));
				} catch (e: unknown) {
					new Notice(t("notice.connFail", lang, { msg: describeLLMFailure(lang, e) }));
				} finally {
					btn.setButtonText(t("set.test", lang));
				}
				})();
			}));

		// --- 工作区（素材 / Wiki 目录） ---
		const wsDetails = containerEl.createEl("details", { cls: "sb-settings-section" });
		wsDetails.createEl("summary", { text: t("set.sectionWorkspace", lang) });
		const wsContent = wsDetails.createDiv();

		new Setting(wsContent)
			.setName(t("set.rawFolder", lang))
			.setDesc(t("set.rawFolderDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.rawFolderPh", lang)).setValue(this.plugin.settings.rawFolder).onChange(async (v) => { this.plugin.settings.rawFolder = v; await this.plugin.saveSettings(); }));

		new Setting(wsContent)
			.setName(t("set.wikiFolder", lang))
			.setDesc(t("set.wikiFolderDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.wikiFolderPh", lang)).setValue(this.plugin.settings.wikiFolder).onChange(async (v) => { this.plugin.settings.wikiFolder = v; await this.plugin.saveSettings(); }));

		new Setting(wsContent)
			.setName(t("set.organizeRaw", lang))
			.setDesc(t("set.organizeRawDesc", lang))
			.addButton((btn) => btn.setButtonText(t("set.organizeRawBtn", lang)).onClick(() => {
				void (async () => {
				await this.plugin.organizeRawMaterials();
				})();
			}));

		// --- 界面与模板 ---
		const uiDetails = containerEl.createEl("details", { cls: "sb-settings-section" });
		uiDetails.createEl("summary", { text: t("set.sectionUi", lang) });
		const uiContent = uiDetails.createDiv();

		new Setting(uiContent)
			.setName(t("set.language", lang))
			.setDesc(t("set.languageDesc", lang))
			.addDropdown((dd) => dd
				.addOptions({ "zh-CN": "简体中文", "en": "English", "ja": "日本語" })
				.setValue(this.plugin.settings.language)
				.onChange(async (v) => { this.plugin.settings.language = v as UILanguageId; await this.plugin.saveSettings(); this.display(); }));

	// --- 编译与智能增强 ---
		const compileDetails = containerEl.createEl("details", { cls: "sb-settings-section" });
		compileDetails.createEl("summary", { text: t("set.sectionCompile", lang) });
		const recContent = compileDetails.createDiv();

		new Setting(recContent)
			.setName(t("set.autoCompile", lang))
			.setDesc(t("set.autoCompileDesc", lang))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.autoCompile)
				.onChange(async (v) => {
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
			.setName(t("set.enableGapDetection", lang))
			.setDesc(t("set.enableGapDetectionDesc", lang))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableGapDetection)
				.onChange(async (v) => {
					this.plugin.settings.enableGapDetection = v;
					await this.plugin.saveSettings();
				}));

		new Setting(recContent)
			.setName(t("set.enableLinkEnrichment", lang))
			.setDesc(t("set.enableLinkEnrichmentDesc", lang))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.enableLinkEnrichment)
				.onChange(async (v) => {
					this.plugin.settings.enableLinkEnrichment = v;
					await this.plugin.saveSettings();
				}));

		new Setting(recContent)
			.setName(t("set.useStreaming", lang))
			.setDesc(t("set.useStreamingDesc", lang))
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.useStreaming)
				.onChange(async (v) => {
					this.plugin.settings.useStreaming = v;
					await this.plugin.saveSettings();
				}));

		// --- 高级设置 ---
		const advDetails = containerEl.createEl("details", { cls: "sb-settings-section" });
		advDetails.createEl("summary", { text: t("set.sectionAdvanced", lang) });
		const advContent = advDetails.createDiv();

		new Setting(advContent).setName(t("set.embedSection", lang)).setHeading();

		new Setting(advContent)
			.setName(t("set.embedModel", lang))
			.setDesc(t("set.embedModelDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.embedModelPh", lang)).setValue(this.plugin.settings.embeddingModel).onChange(async (v) => {
				this.plugin.settings.embeddingModel = v;
				await this.plugin.saveSettings();
			}));

		new Setting(advContent)
			.setName(t("set.embedUrl", lang))
			.setDesc(t("set.embedUrlDesc", lang))
			.addText((t2) => t2.setPlaceholder(t("set.embedUrlPh", lang)).setValue(this.plugin.settings.embeddingBaseUrl).onChange(async (v) => {
				this.plugin.settings.embeddingBaseUrl = v;
				await this.plugin.saveSettings();
			}));

		new Setting(advContent)
			.setName(t("set.embedKey", lang))
			.setDesc(t("set.embedKeyDesc", lang))
			.addText((t2) => {
				t2.setPlaceholder("Sk-...").setValue(this.plugin.settings.embeddingApiKey).onChange(async (v) => {
					this.plugin.settings.embeddingApiKey = v;
					await this.plugin.saveSettings();
				});
				t2.inputEl.type = "password";
			});

		new Setting(advContent).setName(t("set.dataSection", lang)).setHeading();

		new Setting(advContent)
			.setName(t("set.cleanWiki", lang))
			.setDesc(t("set.cleanWikiDesc", lang))
			.addButton((btn) => btn.setButtonText(t("set.cleanWikiBtn", lang)).setWarning().onClick(() => {
					void (() => {
				const modal = new Modal(this.app);
				new Setting(modal.contentEl).setName(t("set.confirmTitle", lang)).setHeading();
				modal.contentEl.createEl("p", { text: t("set.confirmDesc", lang) });
				modal.contentEl.createEl("p", { text: t("set.confirmHint", lang) });
				const input = modal.contentEl.createEl("input", { type: "text", placeholder: t("set.confirmPh", lang) });

				const btnRow = modal.contentEl.createDiv();
				btnRow.classList.add("sb-flex-row-end");

				const cancelBtn = btnRow.createEl("button", { text: t("set.cancel", lang) });
				cancelBtn.addEventListener("click", () => modal.close());

				const confirmBtn = btnRow.createEl("button", { text: t("set.confirmBtn", lang), cls: "mod-warning" });
				confirmBtn.addEventListener("click", () => {
					void (async () => {
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
								await this.app.fileManager.trashFile(file);
							}
						}
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
					})();
				});
				modal.open();
					})();
			}));

		new Setting(advContent)
			.setName(t("set.cleanCache", lang))
			.setDesc(t("set.cleanCacheDesc", lang))
			.addButton((btn) => btn.setButtonText(t("set.cleanCacheBtn", lang)).setWarning().onClick(() => {
				void (async () => {
				await this.plugin.saveData(emptyCache());
				clearEmbeddingCache();
				new Notice(t("notice.cacheCleaned", lang));
				})();
			}));
	}

	// --- 健康检查 ---
	private renderHealthBar(containerEl: HTMLElement, lang: string) {
		const bar = containerEl.createDiv({ cls: "sb-health-bar" });

		// API 状态
		const apiItem = bar.createDiv({ cls: "sb-health-item" });
		apiItem.createSpan({ cls: "sb-health-dot sb-health-err" });
		apiItem.createSpan({ text: t("health.apiFail", lang), cls: "sb-health-label" });
		if (this.plugin.settings.apiKey) {
			apiItem.querySelector(".sb-health-dot")?.classList.replace("sb-health-err", "sb-health-ok");
			apiItem.querySelector(".sb-health-label")?.setText(t("health.apiOk", lang));
		}

		// raw/ 目录
		const rawItem = bar.createDiv({ cls: "sb-health-item" });
		const rawFolder = this.plugin.settings.rawFolder;
		const rawExists = !!this.app.vault.getAbstractFileByPath(rawFolder);
		const rawFileCount = rawExists ? this.app.vault.getFiles().filter(f => f.path.startsWith(rawFolder + "/")).length : 0;
		rawItem.createSpan({ cls: `sb-health-dot ${rawExists ? "sb-health-ok" : "sb-health-err"}` });
		rawItem.createSpan({ text: rawExists ? t("health.rawOk", lang, { n: rawFileCount }) : t("health.rawFail", lang), cls: "sb-health-label" });

		// 编译状态
		const compileItem = bar.createDiv({ cls: "sb-health-item" });
		const wikiFolder = this.plugin.settings.wikiFolder;
		const wikiExists = !!this.app.vault.getAbstractFileByPath(wikiFolder);
		compileItem.createSpan({ cls: `sb-health-dot ${wikiExists ? "sb-health-ok" : "sb-health-err"}` });
		compileItem.createSpan({ text: wikiExists ? t("health.compiled", lang) : t("health.notCompiled", lang), cls: "sb-health-label" });

		// 刷新按钮
		const refreshBtn = bar.createEl("button", { text: t("health.refresh", lang), cls: "sb-health-refresh" });
		refreshBtn.addEventListener("click", () => this.display());
	}
}

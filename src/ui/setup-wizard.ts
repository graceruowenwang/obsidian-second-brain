// 首次使用设置向导

import { App, Modal, Setting } from "obsidian";
import type { LLMProviderId, SecondBrainPlugin } from "../types";
import { callLLM } from "../core/llm";
import { PROVIDER_PRESETS, providerPresetOrUndefined } from "../core/presets";
import { t } from "../core/i18n";
import { RAW_STANDARD_SUBFOLDERS } from "../core/raw-organize";
import { hasAnySampleSource, loadSamplesIntoVault } from "../core/sample-loader";

export class SetupWizardModal extends Modal {
	private plugin: SecondBrainPlugin;
	private step = 0;
	private container!: HTMLElement;

	constructor(app: App, plugin: SecondBrainPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.titleEl.setText(t("wizard.title", this.plugin.settings.language));
		this.container = this.contentEl.createDiv({ cls: "sb-wizard" });
		this.renderStep();
	}

	private renderStep() {
		this.container.empty();
		const lang = this.plugin.settings.language;

		// Step progress indicator (show on steps 1-4, not welcome)
		if (this.step >= 1) {
			const progress = this.container.createDiv({ cls: "sb-wizard-progress" });
			const labels = ["", t("wizard.step1", lang), t("wizard.step2", lang), t("wizard.step3SamplesTitle", lang), t("wizard.step3", lang)];
			for (let i = 1; i <= 4; i++) {
				const dot = progress.createDiv({ cls: "sb-wizard-progress-dot" + (i === this.step ? " active" : "") + (i < this.step ? " done" : "") });
				dot.createSpan({ text: String(i) });
			}
			const currentLabel = labels[this.step] || "";
			if (currentLabel) progress.createSpan({ text: currentLabel, cls: "sb-wizard-progress-label" });
		}

		if (this.step === 0) {
			this.renderStep0Welcome(lang);
		} else if (this.step === 1) {
			this.renderStep1(lang);
		} else if (this.step === 2) {
			void this.renderStep2(lang);
		} else if (this.step === 3) {
			this.renderStep3Samples(lang);
		} else {
			this.renderStep4(lang);
		}
	}

	// Step 0: 价值展示欢迎页
	private renderStep0Welcome(lang: string) {
		this.container.createEl("h2", { text: t("wizard.welcomeTitle", lang), cls: "sb-wizard-welcome-title" });
		this.container.createEl("p", { text: t("wizard.welcomeDesc", lang), cls: "sb-wizard-welcome-desc" });

		// 3 value proposition cards
		const cardsRow = this.container.createDiv({ cls: "sb-wizard-value-cards" });
		const cards = [
			{ titleKey: "wizard.valueCard1Title", descKey: "wizard.valueCard1Desc", icon: "sb-wizard-icon-fragments" },
			{ titleKey: "wizard.valueCard2Title", descKey: "wizard.valueCard2Desc", icon: "sb-wizard-icon-ai" },
			{ titleKey: "wizard.valueCard3Title", descKey: "wizard.valueCard3Desc", icon: "sb-wizard-icon-links" },
		];
		for (const c of cards) {
			const card = cardsRow.createDiv({ cls: "sb-wizard-value-card" });
			card.createDiv({ cls: `sb-wizard-value-icon ${c.icon}` });
			card.createEl("h4", { text: t(c.titleKey, lang) });
			card.createEl("p", { text: t(c.descKey, lang) });
		}

		// Before/After comparison
		const comparison = this.container.createDiv({ cls: "sb-wizard-comparison" });
		const before = comparison.createDiv({ cls: "sb-wizard-compare-box sb-wizard-compare-before" });
		before.createSpan({ text: t("wizard.beforeLabel", lang), cls: "sb-wizard-compare-label" });
		before.createDiv({ cls: "sb-wizard-compare-content", text: t("wizard.beforeSample", lang) });
		comparison.createDiv({ cls: "sb-wizard-compare-arrow", text: "\u2192" });
		const after = comparison.createDiv({ cls: "sb-wizard-compare-box sb-wizard-compare-after" });
		after.createSpan({ text: t("wizard.afterLabel", lang), cls: "sb-wizard-compare-label" });
		after.createDiv({ cls: "sb-wizard-compare-content", text: t("wizard.afterSample", lang) });

		// Buttons
		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });
		const startBtn = btnRow.createEl("button", { text: t("wizard.startSetup", lang), cls: "mod-cta" });
		startBtn.addEventListener("click", () => { this.step = 1; this.renderStep(); });
		const skipBtn = btnRow.createEl("button", { text: t("wizard.skip", lang) });
		skipBtn.addEventListener("click", () => { void this.finish(); });
	}

	// Step 1: LLM 配置 (原 Step 0)
	private renderStep1(lang: string) {
		this.container.createEl("h3", { text: t("wizard.step1", lang) });
		this.container.createEl("p", { text: t("wizard.step1Desc", lang) });

		new Setting(this.container)
			.setName(t("set.provider", lang))
			.addDropdown((dd) => {
				dd.addOption("", "-- --");
				for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
					dd.addOption(key, preset.label);
				}
				dd.setValue(this.plugin.settings.provider);
				dd.onChange(async (v) => {
					const preset = PROVIDER_PRESETS[v as keyof typeof PROVIDER_PRESETS];
					if (preset) {
						this.plugin.settings.provider = v as LLMProviderId;
						this.plugin.settings.baseUrl = preset.baseUrl;
						this.plugin.settings.model = preset.models[0];
						await this.plugin.saveSettings();
					}
				});
			});

		const apiKeySetting = new Setting(this.container)
			.setName(t("set.apiKey", lang))
			.addText((t2) => {
				t2.setPlaceholder("Sk-...").setValue(this.plugin.settings.apiKey);
				t2.inputEl.type = "password";
				t2.onChange(async (v) => {
					this.plugin.settings.apiKey = v;
					await this.plugin.saveSettings();
				});
			});
			const preset = providerPresetOrUndefined(this.plugin.settings.provider);
			if (preset) {
				apiKeySetting.descEl.createEl("a", { text: t("set.getApiKey", lang), href: preset.keyUrl });
			}

		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });

		const testBtn = btnRow.createEl("button", { text: t("wizard.testConn", lang) });
		testBtn.addEventListener("click", () => {
			void (async () => {
			testBtn.textContent = "...";
			try {
				await callLLM([{ role: "user", content: "Hi" }], this.plugin.settings, { maxTokens: 5, temperature: 0 });
				testBtn.textContent = "OK";
				testBtn.classList.add("mod-cta");
			} catch (e) {
				console.warn("setup-wizard: test failed:", e);
				testBtn.textContent = "FAIL";
				testBtn.classList.add("mod-warning");
			}
			activeWindow.setTimeout(() => {
				testBtn.textContent = t("wizard.testConn", lang);
				testBtn.classList.remove("mod-cta", "mod-warning");
			}, 2000);
			})();
		});

		const nextBtn = btnRow.createEl("button", { text: t("wizard.next", lang), cls: "mod-cta" });
		nextBtn.addEventListener("click", () => { this.step = 2; this.renderStep(); });

		const skipBtn = btnRow.createEl("button", { text: t("wizard.skip", lang) });
		skipBtn.addEventListener("click", () => { void this.finish(); });
	}

	// Step 2: 目录配置 (原 Step 1)
	private async renderStep2(lang: string) {
		this.container.createEl("h3", { text: t("wizard.step2", lang) });
		this.container.createEl("p", { text: t("wizard.step2Desc", lang) });

		const statusEl = this.container.createDiv({ cls: "sb-wizard-status" });

		const rawFolder = this.plugin.settings.rawFolder;
		const subfolders = [rawFolder, ...RAW_STANDARD_SUBFOLDERS.map((s) => `${rawFolder}/${s}`)];

		for (const folder of subfolders) {
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (!existing) {
				try {
					await this.app.vault.createFolder(folder);
					statusEl.createDiv({ text: `+ ${folder}/`, cls: "sb-wizard-folder-created" });
				} catch (e) {
					console.warn("setup-wizard: folder creation:", e);
					statusEl.createDiv({ text: `! ${folder}/`, cls: "sb-wizard-folder-error" });
				}
			} else {
				statusEl.createDiv({ text: `  ${folder}/`, cls: "sb-wizard-folder-exists" });
			}
		}

		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });
		const prevBtn = btnRow.createEl("button", { text: t("wizard.prev", lang) });
		prevBtn.addEventListener("click", () => { this.step = 1; this.renderStep(); });

		const nextBtn = btnRow.createEl("button", { text: t("wizard.next", lang), cls: "mod-cta" });
		nextBtn.addEventListener("click", () => { this.step = 3; this.renderStep(); });

		const skipBtn = btnRow.createEl("button", { text: t("wizard.skip", lang) });
		skipBtn.addEventListener("click", () => { void this.finish(); });
	}

	// Step 3: 加载示例素材
	private renderStep3Samples(lang: string) {
		this.container.createEl("h3", { text: t("wizard.step3SamplesTitle", lang) });
		this.container.createEl("p", { text: t("wizard.step3SamplesDesc", lang) });

		const statusEl = this.container.createDiv({ cls: "sb-wizard-samples-status" });

		const rawFolder = this.plugin.settings.rawFolder;
		const wikiFolder = this.plugin.settings.wikiFolder;
		const hasSampleSource = hasAnySampleSource(this.app);
		const hasRaw = this.app.vault.getAbstractFileByPath(rawFolder);
		let rawHasFiles = false;
		if (hasRaw) {
			const files = this.app.vault.getFiles();
			rawHasFiles = files.some(f => f.path.startsWith(rawFolder + "/") && !f.path.includes("_usage"));
		}

		if (rawHasFiles) {
			statusEl.createDiv({ text: t("wizard.step3SamplesAlreadyHas", lang), cls: "sb-wizard-folder-exists" });
		} else {
			const loadBtn = statusEl.createEl("button", { text: t("wizard.step3SamplesLoad", lang), cls: "mod-cta" });
			loadBtn.classList.add("sb-mt-12");
			loadBtn.disabled = !hasSampleSource;
			loadBtn.addEventListener("click", () => {
				void (async () => {
				loadBtn.textContent = "...";
				try {
					await loadSamplesIntoVault(this.app, rawFolder, wikiFolder);
					loadBtn.textContent = t("wizard.step3SamplesDone", lang);
					loadBtn.classList.add("mod-cta");
				} catch (e) {
					console.warn("setup-wizard: sample load failed:", e);
					loadBtn.textContent = t("wizard.step3SamplesFail", lang);
				}
				})();
			});
		}

		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });
		const prevBtn = btnRow.createEl("button", { text: t("wizard.prev", lang) });
		prevBtn.addEventListener("click", () => { this.step = 2; this.renderStep(); });

		const nextBtn = btnRow.createEl("button", { text: t("wizard.next", lang), cls: "mod-cta" });
		nextBtn.addEventListener("click", () => { this.step = 4; this.renderStep(); });

		const skipBtn = btnRow.createEl("button", { text: t("wizard.skip", lang) });
		skipBtn.addEventListener("click", () => { void this.finish(); });
	}

	// Step 4: 完成
	private renderStep4(lang: string) {
		this.container.createEl("h3", { text: t("wizard.step3", lang) });
		this.container.createEl("p", { text: t("wizard.step3Desc", lang) });

		// Completion guidance
		const guide = this.container.createDiv({ cls: "sb-wizard-complete-guide" });
		guide.createEl("p", { text: t("wizard.completeGuide", lang) || "完成后，打开编译面板开始将素材编译为知识库。", cls: "sb-wizard-complete-text" });
		const compileBtn = guide.createEl("button", { text: t("wizard.openCompile", lang) || "打开编译面板", cls: "mod-cta sb-wizard-compile-btn" });
		compileBtn.addEventListener("click", () => {
			void this.finish();
			void this.plugin.activateView("second-brain-compile");
		});

		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });
		const prevBtn = btnRow.createEl("button", { text: t("wizard.prev", lang) });
		prevBtn.addEventListener("click", () => { this.step = 3; this.renderStep(); });

		const doneBtn = btnRow.createEl("button", { text: t("wizard.done", lang), cls: "mod-cta" });
		doneBtn.addEventListener("click", () => { void this.finish(); });
	}

	private async finish() {
		this.plugin.settings.setupCompleted = true;
		await this.plugin.saveSettings();
		this.close();
	}

	onClose() {
		if (!this.plugin.settings.setupCompleted) {
			this.plugin.settings.setupCompleted = true;
			void this.plugin.saveSettings();
		}
	}
}

// 首次使用设置向导

import { App, Modal, Notice, Setting } from "obsidian";
import type { SecondBrainPlugin } from "../types";
import { callLLM } from "../core/llm";
import { PROVIDER_PRESETS } from "../core/presets";
import { t } from "../core/i18n";

export class SetupWizardModal extends Modal {
	private plugin: SecondBrainPlugin;
	private step = 0;
	private container: HTMLElement;

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

		if (this.step === 0) {
			this.renderStep1(lang);
		} else if (this.step === 1) {
			this.renderStep2(lang);
		} else {
			this.renderStep3(lang);
		}
	}

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
					const preset = PROVIDER_PRESETS[v];
					if (preset) {
						this.plugin.settings.provider = v;
						this.plugin.settings.baseUrl = preset.baseUrl;
						this.plugin.settings.model = preset.models[0];
						await this.plugin.saveData(this.plugin.settings);
					}
				});
			});

		new Setting(this.container)
			.setName(t("set.apiKey", lang))
			.addText((t2) => {
				t2.setPlaceholder("sk-...").setValue(this.plugin.settings.apiKey);
				t2.inputEl.type = "password";
				t2.onChange(async (v) => {
					this.plugin.settings.apiKey = v;
					await this.plugin.saveData(this.plugin.settings);
				});
			});

		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });

		const testBtn = btnRow.createEl("button", { text: t("wizard.testConn", lang) });
		testBtn.addEventListener("click", async () => {
			testBtn.textContent = "...";
			try {
				await callLLM([{ role: "user", content: "Hi" }], this.plugin.settings, { maxTokens: 5, temperature: 0 });
				testBtn.textContent = "OK";
				testBtn.classList.add("mod-cta");
			} catch {
				testBtn.textContent = "FAIL";
				testBtn.classList.add("mod-warning");
			}
			setTimeout(() => {
				testBtn.textContent = t("wizard.testConn", lang);
				testBtn.classList.remove("mod-cta", "mod-warning");
			}, 2000);
		});

		const nextBtn = btnRow.createEl("button", { text: t("wizard.next", lang), cls: "mod-cta" });
		nextBtn.addEventListener("click", () => {
			this.step = 1;
			this.renderStep();
		});

		const skipBtn = btnRow.createEl("button", { text: t("wizard.skip", lang) });
		skipBtn.addEventListener("click", () => this.finish());
	}

	private async renderStep2(lang: string) {
		this.container.createEl("h3", { text: t("wizard.step2", lang) });
		this.container.createEl("p", { text: t("wizard.step2Desc", lang) });

		const statusEl = this.container.createDiv({ cls: "sb-wizard-status" });

		const rawFolder = this.plugin.settings.rawFolder;
		const subfolders = [
			rawFolder,
			`${rawFolder}/01-articles`,
			`${rawFolder}/05-tweets`,
			`${rawFolder}/06-flash_notes`,
			`${rawFolder}/06-flash_notes/inbox`,
		];

		for (const folder of subfolders) {
			const existing = this.app.vault.getAbstractFileByPath(folder);
			if (!existing) {
				try {
					await this.app.vault.createFolder(folder);
					statusEl.createDiv({ text: `+ ${folder}/`, cls: "sb-wizard-folder-created" });
				} catch {
					statusEl.createDiv({ text: `! ${folder}/`, cls: "sb-wizard-folder-exists" });
				}
			} else {
				statusEl.createDiv({ text: `  ${folder}/`, cls: "sb-wizard-folder-exists" });
			}
		}

		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });
		const prevBtn = btnRow.createEl("button", { text: t("wizard.prev", lang) });
		prevBtn.addEventListener("click", () => { this.step = 0; this.renderStep(); });

		const nextBtn = btnRow.createEl("button", { text: t("wizard.next", lang), cls: "mod-cta" });
		nextBtn.addEventListener("click", () => { this.step = 2; this.renderStep(); });

		const skipBtn = btnRow.createEl("button", { text: t("wizard.skip", lang) });
		skipBtn.addEventListener("click", () => this.finish());
	}

	private renderStep3(lang: string) {
		this.container.createEl("h3", { text: t("wizard.step3", lang) });
		this.container.createEl("p", { text: t("wizard.step3Desc", lang) });

		const btnRow = this.container.createDiv({ cls: "sb-wizard-btn-row" });
		const prevBtn = btnRow.createEl("button", { text: t("wizard.prev", lang) });
		prevBtn.addEventListener("click", () => { this.step = 1; this.renderStep(); });

		const doneBtn = btnRow.createEl("button", { text: t("wizard.done", lang), cls: "mod-cta" });
		doneBtn.addEventListener("click", () => this.finish());
	}

	private async finish() {
		this.plugin.settings.setupCompleted = true;
		await this.plugin.saveData(this.plugin.settings);
		this.close();
	}

	onClose() {
		if (!this.plugin.settings.setupCompleted) {
			this.plugin.settings.setupCompleted = true;
			this.plugin.saveData(this.plugin.settings);
		}
	}
}

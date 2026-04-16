// 编译面板 — 右侧栏 View，显示编译进度和日志

import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { runCompile } from "../core/compile";
import { readRawFiles } from "../core/file-utils";
import type { SecondBrainPlugin, ProgressEvent } from "../types";

export const VIEW_TYPE_COMPILE = "second-brain-compile";

export class CompileView extends ItemView {
	plugin: SecondBrainPlugin;
	private logEl: HTMLElement;
	private progressFill: HTMLElement;
	private progressLabel: HTMLElement;
	private compileBtn: HTMLButtonElement;
	private statusEl: HTMLElement;
	private compiling = false;

	constructor(leaf: WorkspaceLeaf, plugin: SecondBrainPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE_COMPILE; }
	getDisplayText() { return "编译"; }
	getIcon() { return "zap"; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.classList.add("second-brain-compile");

		// 按钮
		const btnRow = container.createDiv({ cls: "sb-btn-row" });
		this.compileBtn = btnRow.createEl("button", { text: "开始编译", cls: "mod-cta" });
		this.compileBtn.addEventListener("click", () => this.startCompile());

		const forceBtn = btnRow.createEl("button", { text: "忽略缓存重编" });
		forceBtn.addEventListener("click", () => this.startCompile(true));

		// 状态
		this.statusEl = container.createDiv({ cls: "sb-status" });

		// 进度条
		const progressWrap = container.createDiv({ cls: "sb-progress-wrap" });
		this.progressLabel = progressWrap.createDiv({ cls: "sb-progress-label" });
		const bar = progressWrap.createDiv({ cls: "sb-progress-bar" });
		this.progressFill = bar.createDiv({ cls: "sb-progress-fill" });

		// 日志
		this.logEl = container.createDiv({ cls: "sb-log" });
		this.addLog("点击「开始编译」运行 AI 编译流程。", "");

		// 加载 raw 文件列表
		this.loadRawFileList(container);
	}

	private async loadRawFileList(container: HTMLElement) {
		const { rawFolder } = this.plugin.settings;
		const files = await readRawFiles(this.app, rawFolder);
		const userList = files.filter(f => !f.path.includes("_usage"));
		if (userList.length > 0) {
			this.addLog(`${rawFolder}/ 下有 ${userList.length} 个素材文件`, "ok");
		} else {
			this.addLog(`${rawFolder}/ 目录为空，请先放入素材`, "err");
		}
	}

	private async startCompile(force = false) {
		if (this.compiling) return;
		const settings = this.plugin.settings;
		if (!settings.apiKey) {
			new Notice("请先在设置中配置 API Key");
			return;
		}

		this.compiling = true;
		this.compileBtn.disabled = true;
		this.compileBtn.textContent = "编译中...";
		this.logEl.empty();
		this.progressFill.style.width = "0%";

		const onProgress = (e: ProgressEvent) => {
			this.progressFill.style.width = `${e.percent}%`;
			this.progressLabel.textContent = `${e.stepName} — ${e.detail} (${e.percent}%)`;
		};

		try {
			const result = await runCompile(this.app, settings, onProgress, force);
			this.addLog(`编译完成：${result.conceptsCount} 概念, ${result.entitiesCount} 实体, ${result.sourcesCount} 来源`, "ok");
			if (result.reused) this.addLog("素材无变化，跳过编译", "");
			if (result.errors.length > 0) {
				this.addLog(`${result.errors.length} 个页面生成失败`, "err");
				for (const e of result.errors) this.addLog(`  ${e.name}: ${e.error}`, "err");
			}
			new Notice("编译完成");
		} catch (e: any) {
			this.addLog(`编译失败: ${e.message}`, "err");
			new Notice(`编译失败: ${e.message}`);
		} finally {
			this.compiling = false;
			this.compileBtn.disabled = false;
			this.compileBtn.textContent = "开始编译";
		}
	}

	addLog(text: string, cls: string) {
		const line = this.logEl.createDiv({ cls: `sb-log-line ${cls}`, text });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}

	async onClose() {}
}

// 编译日志系统 -- 结构化记录编译过程

import { App, TFile } from "obsidian";

export interface CompilePageLog {
	path: string;
	name: string;
	status: "generated" | "skipped" | "failed" | "outdated" | "protected";
	reason?: string;
	durationMs?: number;
}

export interface CompileLog {
	timestamp: string;
	action: "full" | "incremental" | "single";
	durationMs: number;
	totalPages: number;
	generated: number;
	skipped: number;
	failed: number;
	protected: number;
	removed: number;
	pages: CompilePageLog[];
}

const CACHE_DIR = ".cache";
const LOG_FILE = "compile-log.json";

export class CompileLogBuilder {
	private pages: CompilePageLog[] = [];
	private startTime = Date.now();
	private action: "full" | "incremental" | "single";
	private totalPages = 0;
	private generated = 0;
	private skipped = 0;
	private failed = 0;
	private protected = 0;
	private removed = 0;

	constructor(action: "full" | "incremental" | "single") {
		this.action = action;
	}

	setTotalPages(n: number): this {
		this.totalPages = n;
		return this;
	}

	setGenerated(n: number): this {
		this.generated = n;
		return this;
	}

	setSkipped(n: number): this {
		this.skipped = n;
		return this;
	}

	setProtected(n: number): this {
		this.protected = n;
		return this;
	}

	setRemoved(n: number): this {
		this.removed = n;
		return this;
	}

	addGenerated(path: string, name: string, durationMs?: number): this {
		this.pages.push({ path, name, status: "generated", durationMs });
		this.generated++;
		return this;
	}

	addSkipped(path: string, name: string, reason?: string): this {
		this.pages.push({ path, name, status: "skipped", reason });
		this.skipped++;
		return this;
	}

	addFailed(path: string, name: string, reason: string): this {
		this.pages.push({ path, name, status: "failed", reason });
		this.failed++;
		return this;
	}

	addProtected(path: string, name: string): this {
		this.pages.push({ path, name, status: "protected" });
		this.protected++;
		return this;
	}

	addRemoved(path: string, name: string): this {
		this.pages.push({ path, name, status: "outdated", reason: "removed from analysis" });
		this.removed++;
		return this;
	}

	build(): CompileLog {
		return {
			timestamp: new Date().toISOString(),
			action: this.action,
			durationMs: Date.now() - this.startTime,
			totalPages: this.totalPages,
			generated: this.generated,
			skipped: this.skipped,
			failed: this.failed,
			protected: this.protected,
			removed: this.removed,
			pages: this.pages,
		};
	}
}

// 保存编译日志到 wiki/.cache/compile-log.json
export async function saveCompileLog(app: App, wikiFolder: string, log: CompileLog): Promise<void> {
	const dirPath = `${wikiFolder}/${CACHE_DIR}`;
	const filePath = `${dirPath}/${LOG_FILE}`;

	// 读取已有日志
	let existing: CompileLog[] = [];
	const existingFile = app.vault.getAbstractFileByPath(filePath);
	if (existingFile instanceof TFile) {
		try {
			const raw = await app.vault.read(existingFile);
			existing = JSON.parse(raw);
			if (!Array.isArray(existing)) existing = [];
		} catch {
			existing = [];
		}
	}

	// 追加新日志，保留最近 50 条
	existing.unshift(log);
	if (existing.length > 50) existing = existing.slice(0, 50);

	// 确保目录存在
	const dir = app.vault.getAbstractFileByPath(dirPath);
	if (!dir) {
		const parts = dirPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!app.vault.getAbstractFileByPath(current)) {
				try {
					await app.vault.createFolder(current);
				} catch {
					// 可能已被其他进程创建
				}
			}
		}
	}

	const content = JSON.stringify(existing, null, 2);
	if (existingFile instanceof TFile) {
		await app.vault.modify(existingFile, content);
	} else {
		await app.vault.create(filePath, content);
	}
}

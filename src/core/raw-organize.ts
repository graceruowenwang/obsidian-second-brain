// 将直接堆在 raw/ 根目录的零散文件移入标准子文件夹（不调用 LLM）

import { App, TFile, TFolder } from "obsidian";
import { ensureFolder } from "./file-utils";

/** 与 raw-sample 一致的常用子目录；整理前会尽量创建 */
export const RAW_STANDARD_SUBFOLDERS = [
	"01-articles",
	"02-books",
	"03-podcasts",
	"04-videos",
	"05-tweets",
	"06-flash_notes",
	"06-flash_notes/inbox",
] as const;

const UNSORTED = "99-unsorted";

/** 闪念阈值：同时满足则视为短文进 inbox */
const FLASH_MAX_LINES = 12;
const FLASH_MAX_CHARS = 600;

export type OrganizeMove = { from: string; to: string };
export type OrganizeError = { path: string; message: string };

export type OrganizeResult = {
	moved: OrganizeMove[];
	errors: OrganizeError[];
};

/** 根据扩展名与体量选择目标子文件夹（相对 raw 根） */
export function pickTargetSubfolder(
	ext: string,
	lineCount: number,
	charCount: number,
): string {
	const e = ext.toLowerCase();
	if (e === "md" || e === "txt") {
		if (lineCount <= FLASH_MAX_LINES && charCount <= FLASH_MAX_CHARS) {
			return "06-flash_notes/inbox";
		}
		return "01-articles";
	}
	return UNSORTED;
}

async function uniqueTargetPath(
	app: App,
	rawFolder: string,
	relFolder: string,
	baseName: string,
	ext: string,
): Promise<string> {
	const dir = `${rawFolder}/${relFolder}`;
	let candidate = `${dir}/${baseName}.${ext}`;
	let n = 1;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = `${dir}/${baseName}-${n}.${ext}`;
		n++;
	}
	return candidate;
}

function isLooseFileInRawRoot(file: TFile, rawFolder: string): boolean {
	const p = file.parent;
	return p instanceof TFolder && p.path === rawFolder;
}

function shouldSkipLooseFile(file: TFile): boolean {
	const base = file.basename;
	if (base.startsWith(".")) return true;
	if (file.name.includes("_usage")) return true;
	return false;
}

/** 创建 raw 下常用子目录（幂等） */
export async function ensureRawSubfolders(app: App, rawFolder: string): Promise<void> {
	for (const sub of RAW_STANDARD_SUBFOLDERS) {
		await ensureFolder(app, `${rawFolder}/${sub}`);
	}
}

/**
 * 将位于 raw 根目录下的零散文件移入子文件夹。
 * 仅处理 raw 的直接子文件；已有子目录内的文件不动。
 */
export async function organizeLooseRawFiles(app: App, rawFolder: string): Promise<OrganizeResult> {
	const moved: OrganizeMove[] = [];
	const errors: OrganizeError[] = [];

	const root = app.vault.getAbstractFileByPath(rawFolder);
	if (!root || !(root instanceof TFolder)) {
		errors.push({ path: rawFolder, message: "raw folder missing" });
		return { moved, errors };
	}

	await ensureRawSubfolders(app, rawFolder);

	const loose = root.children.filter(
		(c): c is TFile => c instanceof TFile && isLooseFileInRawRoot(c, rawFolder) && !shouldSkipLooseFile(c),
	);
	loose.sort((a, b) => a.path.localeCompare(b.path));

	for (const file of loose) {
		const ext = file.extension || "";
		let lineCount = 1;
		let charCount = 0;
		if (ext.toLowerCase() === "md" || ext.toLowerCase() === "txt") {
			try {
				const body = await app.vault.cachedRead(file);
				charCount = body.length;
				lineCount = body.length === 0 ? 0 : body.split(/\r?\n/).length;
			} catch (e) {
				errors.push({ path: file.path, message: (e as Error).message });
				continue;
			}
		}

		const relFolder = pickTargetSubfolder(ext, lineCount, charCount);
		if (relFolder === UNSORTED) {
			await ensureFolder(app, `${rawFolder}/${UNSORTED}`);
		}

		try {
			const fromPath = file.path;
			const target = await uniqueTargetPath(app, rawFolder, relFolder, file.basename, ext);
			await app.vault.rename(file, target);
			moved.push({ from: fromPath, to: target });
		} catch (e) {
			errors.push({ path: file.path, message: (e as Error).message });
		}
	}

	return { moved, errors };
}

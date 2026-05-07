// 将直接堆在 raw/ 根目录的零散文件移入标准子文件夹（不调用 LLM）

import { App, TFile, TFolder } from "obsidian";
import { ensureFolder, normalizeVaultFolderPath } from "./file-utils";

/** 与「整理 raw」一致的常用子目录；整理前会尽量创建（01–06 按素材类型，07 访谈/咨询，08 闪念/收件箱，99 待整理） */
export const RAW_SUBFOLDER_ARTICLES = "01-文章剪藏";
export const RAW_SUBFOLDER_BOOKS = "02-书籍笔记";
export const RAW_SUBFOLDER_PODCASTS = "03-播客笔记";
export const RAW_SUBFOLDER_VIDEOS = "04-视频内容";
export const RAW_SUBFOLDER_COURSES = "05-课程笔记";
export const RAW_SUBFOLDER_WECHAT = "06-公众号长文";
/** 心理咨询、用户/专家访谈、督导与个案记录等（长文 md/txt 可由启发式归入，也可手动放入） */
export const RAW_SUBFOLDER_INTERVIEW = "07-访谈与咨询记录";
/** 「闪念 / flash notes」：极短随手记；与重要性无关，仅按体量启发式进收件箱 */
export const RAW_SUBFOLDER_FLASH = "08-闪念速记";
export const RAW_FLASH_INBOX = `${RAW_SUBFOLDER_FLASH}/收件箱`;
export const RAW_SUBFOLDER_UNSORTED = "99-待整理";

/** 仅列「要创建」的路径：`08-闪念速记/收件箱` 会顺带创建父级 `08-闪念速记`，勿再单独列父目录以免重复 ensure */
export const RAW_STANDARD_SUBFOLDERS = [
	RAW_SUBFOLDER_ARTICLES,
	RAW_SUBFOLDER_BOOKS,
	RAW_SUBFOLDER_PODCASTS,
	RAW_SUBFOLDER_VIDEOS,
	RAW_SUBFOLDER_COURSES,
	RAW_SUBFOLDER_WECHAT,
	RAW_SUBFOLDER_INTERVIEW,
	RAW_FLASH_INBOX,
	RAW_SUBFOLDER_UNSORTED,
] as const;

/** 闪念阈值：同时满足则视为短文进收件箱（不是「优先级更高」，只是「像便签条」的归类） */
const FLASH_MAX_LINES = 12;
const FLASH_MAX_CHARS = 600;

const INTERVIEW_HINTS = [
	"访谈", "咨询", "督导", "个案", "心理咨询", "心理諮商", "来访者", "会谈", "intake", "session",
] as const;

function looksLikeInterviewOrCounselingNote(baseName: string, textHead: string): boolean {
	const n = (baseName || "").toLowerCase();
	const h = (textHead || "").slice(0, 1200);
	for (const k of INTERVIEW_HINTS) {
		if (n.includes(k.toLowerCase()) || h.includes(k)) return true;
	}
	return false;
}

export type OrganizeMove = { from: string; to: string };
export type OrganizeError = { path: string; message: string };

export type OrganizeResult = {
	moved: OrganizeMove[];
	errors: OrganizeError[];
};

export type PickTargetHint = { baseName?: string; textHead?: string };

/**
 * 根据扩展名与体量选择目标子文件夹（相对 raw 根）。
 * 无「素材重要性优先级」：短 md/txt 进闪念收件箱是体量启发式；长文若像访谈/咨询则进 07，否则进文章剪藏；网页存档（html/url 等）进 01；独立图片进 99。
 */
export function pickTargetSubfolder(
	ext: string,
	lineCount: number,
	charCount: number,
	hint?: PickTargetHint,
): string {
	const e = ext.toLowerCase();
	if (e === "md" || e === "txt") {
		if (lineCount <= FLASH_MAX_LINES && charCount <= FLASH_MAX_CHARS) {
			return RAW_FLASH_INBOX;
		}
		if (looksLikeInterviewOrCounselingNote(hint?.baseName ?? "", hint?.textHead ?? "")) {
			return RAW_SUBFOLDER_INTERVIEW;
		}
		return RAW_SUBFOLDER_ARTICLES;
	}

	if (["pdf", "epub", "mobi", "azw3"].includes(e)) return RAW_SUBFOLDER_BOOKS;
	if (["mp3", "m4a", "wav", "aac", "flac"].includes(e)) return RAW_SUBFOLDER_PODCASTS;
	if (["mp4", "mov", "mkv", "avi", "webm"].includes(e)) return RAW_SUBFOLDER_VIDEOS;
	if (["ppt", "pptx", "key", "doc", "docx"].includes(e)) return RAW_SUBFOLDER_COURSES;
	if (["html", "htm", "url", "webloc"].includes(e)) return RAW_SUBFOLDER_ARTICLES;
	if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(e)) return RAW_SUBFOLDER_UNSORTED;

	return RAW_SUBFOLDER_UNSORTED;
}

function uniqueTargetPath(
	app: App,
	rawFolder: string,
	relFolder: string,
	baseName: string,
	ext: string,
): string {
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

/** 若列表中已有 `a/b`，则跳过单独的 `a`，避免对已存在的父路径重复 ensure */
function dedupeEnsurableSubfolders(subs: readonly string[]): string[] {
	const norm = [...new Set(subs.map((s) => normalizeVaultFolderPath(s)).filter(Boolean))];
	norm.sort((a, b) => b.length - a.length);
	const kept: string[] = [];
	for (const p of norm) {
		if (kept.some((k) => k.startsWith(`${p}/`))) continue;
		kept.push(p);
	}
	return kept.sort((a, b) => a.localeCompare(b, "zh-CN"));
}

/** 创建 raw 下常用子目录（幂等；已存在则不再创建） */
export async function ensureRawSubfolders(app: App, rawFolder: string): Promise<void> {
	const root = normalizeVaultFolderPath(rawFolder);
	for (const sub of dedupeEnsurableSubfolders(RAW_STANDARD_SUBFOLDERS)) {
		await ensureFolder(app, root ? `${root}/${sub}` : sub);
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
		const extLower = ext.toLowerCase();
		let lineCount = 1;
		let charCount = 0;
		let body: string | undefined;
		if (extLower === "md" || extLower === "txt") {
			try {
				body = await app.vault.cachedRead(file);
				charCount = body.length;
				lineCount = body.length === 0 ? 0 : body.split(/\r?\n/).length;
			} catch (e) {
				errors.push({ path: file.path, message: (e as Error).message });
				continue;
			}
		}

		const hint: PickTargetHint | undefined =
			extLower === "md" || extLower === "txt"
				? { baseName: file.basename, textHead: (body ?? "").slice(0, 1200) }
				: undefined;
		const relFolder = pickTargetSubfolder(ext, lineCount, charCount, hint);
		if (relFolder === RAW_SUBFOLDER_UNSORTED) {
			await ensureFolder(app, `${rawFolder}/${RAW_SUBFOLDER_UNSORTED}`);
		}

		try {
			const fromPath = file.path;
			const target = uniqueTargetPath(app, rawFolder, relFolder, file.basename, ext);
			await app.vault.rename(file, target);
			moved.push({ from: fromPath, to: target });
		} catch (e) {
			errors.push({ path: file.path, message: (e as Error).message });
		}
	}

	return { moved, errors };
}

import { App, TFile, TFolder } from "obsidian";
import { ensureFolder } from "./file-utils";

export const SAMPLE_SOURCE_CANDIDATES = ["demo/raw", "raw-sample"] as const;
export const SAMPLE_WIKI_SOURCE_CANDIDATES = ["demo/wiki", "wiki-sample"] as const;

function listSampleFiles(app: App, sourceRoot: string): TFile[] {
	const prefix = `${sourceRoot}/`;
	return app.vault.getFiles().filter((f) => f.path.startsWith(prefix));
}

export function detectSampleSourceRoot(app: App): string | null {
	for (const sourceRoot of SAMPLE_SOURCE_CANDIDATES) {
		const folder = app.vault.getAbstractFileByPath(sourceRoot);
		if (!(folder instanceof TFolder)) continue;
		if (listSampleFiles(app, sourceRoot).length > 0) return sourceRoot;
	}
	return null;
}

function detectWikiSampleSourceRoot(app: App): string | null {
	for (const sourceRoot of SAMPLE_WIKI_SOURCE_CANDIDATES) {
		const folder = app.vault.getAbstractFileByPath(sourceRoot);
		if (!(folder instanceof TFolder)) continue;
		if (listSampleFiles(app, sourceRoot).length > 0) return sourceRoot;
	}
	return null;
}

export function hasAnySampleSource(app: App): boolean {
	return !!detectSampleSourceRoot(app) || !!detectWikiSampleSourceRoot(app);
}

async function copySampleTree(
	app: App,
	sourceRoot: string,
	targetRoot: string,
): Promise<number> {
	const files = listSampleFiles(app, sourceRoot);
	const sourcePrefix = `${sourceRoot}/`;
	let copied = 0;
	for (const f of files) {
		const rel = f.path.slice(sourcePrefix.length);
		const targetPath = `${targetRoot}/${rel}`;
		const existing = app.vault.getAbstractFileByPath(targetPath);
		if (existing) continue;
		const content = await app.vault.read(f);
		const folderPath = targetPath.substring(0, targetPath.lastIndexOf("/"));
		if (folderPath) await ensureFolder(app, folderPath);
		await app.vault.create(targetPath, content);
		copied++;
	}
	return copied;
}

export async function loadSamplesIntoVault(
	app: App,
	rawFolder: string,
	wikiFolder: string,
): Promise<{ rawSourceRoot: string | null; wikiSourceRoot: string | null; rawCopied: number; wikiCopied: number }> {
	const rawSourceRoot = detectSampleSourceRoot(app);
	const wikiSourceRoot = detectWikiSampleSourceRoot(app);

	if (!rawSourceRoot && !wikiSourceRoot) {
		throw new Error("SB_SAMPLE_SOURCE_NOT_FOUND");
	}

	let rawCopied = 0;
	let wikiCopied = 0;
	if (rawSourceRoot) rawCopied = await copySampleTree(app, rawSourceRoot, rawFolder);
	if (wikiSourceRoot) wikiCopied = await copySampleTree(app, wikiSourceRoot, wikiFolder);

	return { rawSourceRoot, wikiSourceRoot, rawCopied, wikiCopied };
}

export async function loadSamplesIntoRaw(app: App, rawFolder: string): Promise<{ sourceRoot: string; copied: number }> {
	const sourceRoot = detectSampleSourceRoot(app);
	if (!sourceRoot) throw new Error("SB_SAMPLE_SOURCE_NOT_FOUND");
	const copied = await copySampleTree(app, sourceRoot, rawFolder);
	return { sourceRoot, copied };
}

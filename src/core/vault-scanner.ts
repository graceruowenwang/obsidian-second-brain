// Vault 素材扫描 — 自动发现 vault 中适合作为素材的笔记

import { App, TFile } from "obsidian";

export interface ScanResult {
	path: string;
	basename: string;
	wordCount: number;
	reason: string;
}

const SKIP_PREFIXES = [
	".trash/",
	"blog/",
	"raw-sample/",
];

export async function scanVaultForMaterials(
	app: App,
	rawFolder: string,
	wikiFolder: string,
): Promise<ScanResult[]> {
	const candidates: ScanResult[] = [];
	const skip = [...SKIP_PREFIXES, app.vault.configDir + "/", rawFolder + "/", wikiFolder + "/"];

	const files = app.vault.getMarkdownFiles();

	for (const file of files) {
		if (skip.some(p => file.path.startsWith(p))) continue;

		const content = await app.vault.cachedRead(file);
		const wordCount = content.split(/\s+/).filter(Boolean).length;
		if (wordCount < 50) continue;

		let reason = "";
		if (content.includes("# ") && wordCount > 200) {
			reason = "longNote";
		} else if ((content.match(/\[\[.*?\]\]/g)?.length ?? 0) > 3) {
			reason = "linkedNote";
		} else if (wordCount > 100) {
			reason = "substantialNote";
		} else {
			continue;
		}

		candidates.push({ path: file.path, basename: file.basename, wordCount, reason });
	}

	candidates.sort((a, b) => b.wordCount - a.wordCount);
	return candidates.slice(0, 20);
}

export async function importToRaw(
	app: App,
	files: string[],
	rawFolder: string,
): Promise<{ imported: number; skipped: number }> {
	let imported = 0;
	let skipped = 0;

	for (const path of files) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) { skipped++; continue; }

		const content = await app.vault.read(file);
		const destPath = `${rawFolder}/${file.name}`;
		const existing = app.vault.getAbstractFileByPath(destPath);
		if (existing) { skipped++; continue; }

		await app.vault.create(destPath, content);
		imported++;
	}

	return { imported, skipped };
}

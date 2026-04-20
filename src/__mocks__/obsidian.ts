// Obsidian API 的单元测试 stub。
// 只提供使被测模块可加载的最小形态；任何依赖真实 vault / ItemView 的测试应走集成测试。

export class TFile {}
export class TFolder { children: unknown[] = []; }
export class TAbstractFile {}
export class Notice { constructor(_msg?: string, _timeout?: number) {} }
export class Modal {}
export class Plugin {}
export class ItemView {}
export class WorkspaceLeaf {}
export class MarkdownRenderer {}
export class Component {}
export type App = unknown;
export type Editor = unknown;
export type MarkdownView = unknown;

export async function requestUrl(_opts: {
	signal?: AbortSignal;
	[key: string]: unknown;
}): Promise<{ status: number; json: unknown; text: string }> {
	return { status: 200, json: {}, text: "" };
}

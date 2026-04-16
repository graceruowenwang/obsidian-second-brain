// 第二大脑 Obsidian 插件 — 类型定义

export interface PluginSettings {
	provider: string;
	model: string;
	apiKey: string;
	baseUrl: string;
	maxTokens: number;
	temperature: number;
	rawFolder: string;
	wikiFolder: string;
	autoCompile: boolean;
	autoCompileDelay: number;
	embeddingProvider: string;
	embeddingModel: string;
	embeddingBaseUrl: string;
	embeddingApiKey: string;
	language: string;
	templateFile: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "deepseek",
	model: "deepseek-chat",
	apiKey: "",
	baseUrl: "https://api.deepseek.com",
	maxTokens: 8000,
	temperature: 0.3,
	rawFolder: "raw",
	wikiFolder: "wiki",
	autoCompile: true,
	autoCompileDelay: 30,
	embeddingProvider: "openai",
	embeddingModel: "text-embedding-3-small",
	embeddingBaseUrl: "https://api.openai.com/v1",
	embeddingApiKey: "",
	language: "zh-CN",
	templateFile: "wiki/templates/prompt-config.json",
};

export interface RawFile {
	path: string;
	content: string;
}

export interface WikiFile {
	path: string;
	content: string;
}

export interface Concept {
	name: string;
	title: string;
	level: string;
	desc: string;
	source_file: string;
}

export interface Entity {
	name: string;
	desc: string;
}

export interface Source {
	name: string;
	source_file: string;
	desc: string;
}

export interface Synthesis {
	name: string;
	question: string;
	concepts: string[];
}

export interface Analysis {
	concepts: Concept[];
	entities: Entity[];
	sources: Source[];
	syntheses: Synthesis[];
}

export interface CompileCache {
	fingerprints: Record<string, Fingerprint>;
	analysis: Analysis | null;
	pages: Record<string, { key: string; generatedAt: string | null }>;
	analysisTime: string | null;
	perFileAnalysis: Record<string, Analysis>;
	indexEntries: Record<string, { type: string; level: string; name: string; title: string; desc: string }>;
}

export interface Fingerprint {
	m: number;
	s: number;
	h?: string;
}

export interface ProgressEvent {
	step: number;
	stepName: string;
	detail: string;
	percent: number;
	pagesDone?: number;
	pagesTotal?: number;
}

// Plugin 类型带 settings（供 View 使用）
import type { Plugin } from "obsidian";
export type SecondBrainPlugin = Plugin & { settings: PluginSettings };

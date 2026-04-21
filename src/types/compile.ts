// 编译引擎相关类型：Analysis、Cache、Report、Fingerprint 等

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

export interface Fingerprint {
	m: number;
	s: number;
	h?: string;
}

export interface FailedPageEntry {
	name: string;
	path: string;
	error: string;
	failCount: number;
	lastFailedAt: string;
}

export interface ValidationIssue {
	field: string;
	index: number;
	issue: string;
	value?: string;
	severity?: "error" | "warning";
}

export interface UsageStats {
	totalCompiles: number;
	successCompiles: number;
	failedCompiles: number;
	totalDurationMs: number;
	firstCompileAt: string | null;
	lastCompileAt: string | null;
	totalConceptsGenerated: number;
	totalEntitiesGenerated: number;
	weeklyCompiles: number;
	lastWeekDate: string;
}

export interface CompileCache {
	version: number;
	fingerprints: Record<string, Fingerprint>;
	analysis: Analysis | null;
	pages: Record<string, { key: string; generatedAt: string | null }>;
	analysisTime: string | null;
	perFileAnalysis: Record<string, Analysis>;
	indexEntries: Record<string, { type: string; level: string; name: string; title: string; desc: string }>;
	failedPages: Record<string, FailedPageEntry>;
	dependencies: Record<string, string[]>;
	gapPages?: Record<string, { name: string; detectedAt: string; referenceCount: number; level: string }>;
	compileHistory?: CompileHistoryEntry[];
	usageStats?: UsageStats;
	weeklyReportLastDate?: string;
	// v1 遗留字段，迁移后清空
	embeddings?: Record<string, number[]>;
}

export interface CompileHistoryEntry {
	date: string;
	action: "full" | "incremental" | "single";
	added: string[];
	modified: string[];
	removed: string[];
	conflicts: string[];
	durationMs: number;
	totalPages: number;
}

export interface CompileReport {
	newConcepts: Array<{ name: string; title: string; sourceFile: string }>;
	modifiedConcepts: Array<{ name: string; title: string; changeSummary: string }>;
	deletedConcepts: Array<{ name: string; title: string }>;
	validationIssues: ValidationIssue[];
	totalPages: number;
	generatedPages: number;
	skippedPages: number;
	failedPages: number;
	protectedPages: number;
	durationMs: number;
}

export interface ChangeImpact {
	rawFile: string;
	affectedPages: Array<{ name: string; type: string }>;
}

export interface CompileResult {
	conceptsCount: number;
	entitiesCount: number;
	sourcesCount: number;
	changed: number;
	skippedByDiff: number;
	generated: number;
	removed: number;
	protectedByReview: number;
	errors: Array<{ name: string; error: string; code?: string }>;
	reused: boolean;
	report?: CompileReport;
	changeImpact?: ChangeImpact[];
	gapDetected?: number;
	stubsGenerated?: number;
	linksAdded?: number;
}

export interface ProgressEvent {
	step: number;
	stepName: string;
	detail: string;
	percent: number;
	pagesDone?: number;
	pagesTotal?: number;
}

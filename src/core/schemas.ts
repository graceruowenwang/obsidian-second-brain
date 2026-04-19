// Zod Schema 定义 -- LLM 输出的结构化校验
// 替代 compile-analysis.ts 中的手写校验逻辑

import { z } from "zod";

// Concept 名称: 非空，TitleCase 格式
export const ConceptNameSchema = z.string().min(1).transform(s => s.trim());

// Level 字段: 从模板配置动态注入有效值，这里做宽松校验
export const ConceptSchema = z.object({
	name: ConceptNameSchema,
	title: z.string().optional().default(""),
	level: z.string().optional().default("方法框架"),
	desc: z.string().optional().default(""),
	source_file: z.string().optional().default(""),
}).transform(c => ({
	...c,
	title: c.title || c.name,
}));

export const EntitySchema = z.object({
	name: z.string().min(1).transform(s => s.trim()),
	desc: z.string().optional().default(""),
});

export const SourceSchema = z.object({
	name: z.string().min(1).transform(s => s.trim()),
	source_file: z.string().optional().default(""),
	desc: z.string().optional().default(""),
});

export const SynthesisSchema = z.object({
	name: z.string().min(1).transform(s => s.trim()),
	question: z.string().optional().default(""),
	concepts: z.array(z.string()).optional().default([]),
}).transform(s => ({
	...s,
	concepts: s.concepts.length >= 2 ? s.concepts : [],
}));

export const AnalysisSchema = z.object({
	concepts: z.array(ConceptSchema).optional().default([]),
	entities: z.array(EntitySchema).optional().default([]),
	sources: z.array(SourceSchema).optional().default([]),
	syntheses: z.array(SynthesisSchema).optional().default([]),
});

// 部分恢复：逐个字段 safeParse，成功的保留，失败的跳过
export interface PartialParseResult {
	concepts: z.infer<typeof ConceptSchema>[];
	entities: z.infer<typeof EntitySchema>[];
	sources: z.infer<typeof SourceSchema>[];
	syntheses: z.infer<typeof SynthesisSchema>[];
	issues: Array<{ field: string; issue: string; severity: "error" | "warning" }>;
}

export function parseAnalysisPartial(raw: unknown): PartialParseResult {
	const result: PartialParseResult = {
		concepts: [],
		entities: [],
		sources: [],
		syntheses: [],
		issues: [],
	};

	if (!raw || typeof raw !== "object") {
		result.issues.push({ field: "root", issue: "LLM 输出不是有效对象", severity: "error" });
		return result;
	}

	const obj = raw as Record<string, unknown>;

	// 逐字段 safeParse
	if (Array.isArray(obj.concepts)) {
		for (let i = 0; i < obj.concepts.length; i++) {
			const parsed = ConceptSchema.safeParse(obj.concepts[i]);
			if (parsed.success) {
				result.concepts.push(parsed.data);
			} else {
				result.issues.push({
					field: `concepts[${i}]`,
					issue: parsed.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join("; "),
					severity: "warning",
				});
			}
		}
	}

	if (Array.isArray(obj.entities)) {
		for (let i = 0; i < obj.entities.length; i++) {
			const parsed = EntitySchema.safeParse(obj.entities[i]);
			if (parsed.success) {
				result.entities.push(parsed.data);
			} else {
				result.issues.push({
					field: `entities[${i}]`,
					issue: parsed.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join("; "),
					severity: "warning",
				});
			}
		}
	}

	if (Array.isArray(obj.sources)) {
		for (let i = 0; i < obj.sources.length; i++) {
			const parsed = SourceSchema.safeParse(obj.sources[i]);
			if (parsed.success) {
				result.sources.push(parsed.data);
			} else {
				result.issues.push({
					field: `sources[${i}]`,
					issue: parsed.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join("; "),
					severity: "warning",
				});
			}
		}
	}

	if (Array.isArray(obj.syntheses)) {
		for (let i = 0; i < obj.syntheses.length; i++) {
			const parsed = SynthesisSchema.safeParse(obj.syntheses[i]);
			if (parsed.success) {
				result.syntheses.push(parsed.data);
			} else {
				result.issues.push({
					field: `syntheses[${i}]`,
					issue: parsed.error.issues.map(e => `${e.path.join(".")}: ${e.message}`).join("; "),
					severity: "warning",
				});
			}
		}
	}

	return result;
}

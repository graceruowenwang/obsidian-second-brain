import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
	resolve: {
		alias: {
			// vitest 无法直接 resolve obsidian 包（仅 Obsidian 运行时提供）。
			// 用空 stub 让纯逻辑模块可测；真正需要 Obsidian API 的函数请做集成测试。
			obsidian: path.resolve(__dirname, "src/__mocks__/obsidian.ts"),
		},
	},
});

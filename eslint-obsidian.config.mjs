import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
	...obsidianmd.configs.recommendedWithLocalesEn,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				project: "./tsconfig.json",
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case-locale-module": ["error", { allowAutoFix: true }],
			"no-restricted-globals": "off",
		},
	},
];

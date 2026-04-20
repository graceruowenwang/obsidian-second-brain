import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { coercePluginSettings } from "../coerce-settings";
import { DEFAULT_SETTINGS, type PluginSettings } from "../../types";

describe("coercePluginSettings", () => {
	beforeEach(() => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("非法 provider 回落到默认", () => {
		const s: PluginSettings = { ...DEFAULT_SETTINGS };
		(s as unknown as { provider: string }).provider = "bogus";
		coercePluginSettings(s);
		expect(s.provider).toBe(DEFAULT_SETTINGS.provider);
	});

	it("非法 language 回落", () => {
		const s: PluginSettings = { ...DEFAULT_SETTINGS };
		(s as unknown as { language: string }).language = "fr";
		coercePluginSettings(s);
		expect(s.language).toBe(DEFAULT_SETTINGS.language);
	});

	it("temperature 钳制到 [0, 2]", () => {
		const s = { ...DEFAULT_SETTINGS, temperature: 99 };
		coercePluginSettings(s);
		expect(s.temperature).toBe(2);
		const s2 = { ...DEFAULT_SETTINGS, temperature: -1 };
		coercePluginSettings(s2);
		expect(s2.temperature).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { pickTargetSubfolder, RAW_STANDARD_SUBFOLDERS } from "../raw-organize";

describe("pickTargetSubfolder", () => {
	it("长文 md 进 01-articles", () => {
		expect(pickTargetSubfolder("md", 20, 800)).toBe("01-articles");
	});

	it("短文 md 进 inbox", () => {
		expect(pickTargetSubfolder("md", 10, 400)).toBe("06-flash_notes/inbox");
	});

	it("边界：刚好超过闪念阈值进 articles", () => {
		expect(pickTargetSubfolder("md", 13, 100)).toBe("01-articles");
		expect(pickTargetSubfolder("md", 5, 601)).toBe("01-articles");
	});

	it("txt 与 md 规则一致", () => {
		expect(pickTargetSubfolder("txt", 3, 50)).toBe("06-flash_notes/inbox");
	});

	it("其它扩展进 99-unsorted", () => {
		expect(pickTargetSubfolder("pdf", 1, 0)).toBe("99-unsorted");
	});
});

describe("RAW_STANDARD_SUBFOLDERS", () => {
	it("包含 inbox 路径", () => {
		expect(RAW_STANDARD_SUBFOLDERS).toContain("06-flash_notes/inbox");
	});
});

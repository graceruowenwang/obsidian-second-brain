import { describe, expect, it } from "vitest";
import {
	pickTargetSubfolder,
	RAW_STANDARD_SUBFOLDERS,
	RAW_FLASH_INBOX,
	RAW_SUBFOLDER_ARTICLES,
	RAW_SUBFOLDER_INTERVIEW,
	RAW_SUBFOLDER_UNSORTED,
} from "../raw-organize";

describe("pickTargetSubfolder", () => {
	it("长文 md 进文章目录", () => {
		expect(pickTargetSubfolder("md", 20, 800)).toBe(RAW_SUBFOLDER_ARTICLES);
		expect(pickTargetSubfolder("md", 20, 800, { baseName: "笔记", textHead: "无关内容" })).toBe(RAW_SUBFOLDER_ARTICLES);
	});

	it("长文 md 含访谈/咨询线索进访谈目录", () => {
		expect(pickTargetSubfolder("md", 20, 800, { baseName: "心理咨询师访谈-第一次", textHead: "" })).toBe(RAW_SUBFOLDER_INTERVIEW);
		expect(pickTargetSubfolder("md", 20, 800, { baseName: "项目复盘", textHead: "本次用户访谈记录如下" })).toBe(RAW_SUBFOLDER_INTERVIEW);
	});

	it("短文 md 进 inbox", () => {
		expect(pickTargetSubfolder("md", 10, 400)).toBe(RAW_FLASH_INBOX);
	});

	it("边界：刚好超过闪念阈值进文章目录", () => {
		expect(pickTargetSubfolder("md", 13, 100)).toBe(RAW_SUBFOLDER_ARTICLES);
		expect(pickTargetSubfolder("md", 5, 601)).toBe(RAW_SUBFOLDER_ARTICLES);
	});

	it("txt 与 md 规则一致", () => {
		expect(pickTargetSubfolder("txt", 3, 50)).toBe(RAW_FLASH_INBOX);
	});

	it("其它扩展按规则进入对应中文目录", () => {
		expect(pickTargetSubfolder("pdf", 1, 0)).toBe("02-书籍笔记");
		expect(pickTargetSubfolder("mp3", 1, 0)).toBe("03-播客笔记");
		expect(pickTargetSubfolder("mp4", 1, 0)).toBe("04-视频内容");
		expect(pickTargetSubfolder("docx", 1, 0)).toBe("05-课程笔记");
		expect(pickTargetSubfolder("html", 1, 0)).toBe(RAW_SUBFOLDER_ARTICLES);
		expect(pickTargetSubfolder("png", 1, 0)).toBe(RAW_SUBFOLDER_UNSORTED);
		expect(pickTargetSubfolder("zip", 1, 0)).toBe(RAW_SUBFOLDER_UNSORTED);
	});
});

describe("RAW_STANDARD_SUBFOLDERS", () => {
	it("包含 inbox 路径", () => {
		expect(RAW_STANDARD_SUBFOLDERS).toContain(RAW_FLASH_INBOX);
	});

	it("不重复列出闪念父目录（仅收件箱路径即可创建父级）", () => {
		expect(RAW_STANDARD_SUBFOLDERS).not.toContain("08-闪念速记");
	});
});

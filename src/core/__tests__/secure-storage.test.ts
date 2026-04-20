import { describe, it, expect, beforeEach, vi } from "vitest";
import { encryptKeys, decryptKeys, isEncryptionAvailable, SecureStorageError } from "../secure-storage";

// 伪造 electron.safeStorage：把明文 base64 化当作"密文"，解密则反过来。
// 能还原原文就认为解密成功。失败路径通过切换 isEncryptionAvailable 返回值模拟。

function setupFakeElectron(opts: { available: boolean; throwOnEncrypt?: boolean; throwOnDecrypt?: boolean }) {
	const fake = {
		safeStorage: {
			isEncryptionAvailable: () => opts.available,
			encryptString: (plain: string) => {
				if (opts.throwOnEncrypt) throw new Error("boom");
				return Buffer.from(plain, "utf-8");
			},
			decryptString: (buf: Buffer) => {
				if (opts.throwOnDecrypt) throw new Error("boom");
				return buf.toString("utf-8");
			},
		},
	};
	(globalThis as any).window = {
		require: (name: string) => (name === "electron" ? fake : null),
	};
}

describe("secure-storage", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		delete (globalThis as any).window;
	});

	it("加密不可用 → isEncryptionAvailable=false，encryptKeys 抛 SecureStorageError", () => {
		setupFakeElectron({ available: false });
		expect(isEncryptionAvailable()).toBe(false);
		expect(() => encryptKeys("k1", "k2")).toThrow(SecureStorageError);
	});

	it("加密可用 → encryptKeys 返回两个字段都存在", () => {
		setupFakeElectron({ available: true });
		const out = encryptKeys("hello", "world");
		expect(out.apiKey).toBeTruthy();
		expect(out.embeddingApiKey).toBeTruthy();
	});

	it("加密抛异常 → encryptKeys 传播 SecureStorageError（而不是静默返回空）", () => {
		setupFakeElectron({ available: true, throwOnEncrypt: true });
		expect(() => encryptKeys("x", "")).toThrow(SecureStorageError);
	});

	it("空 key → 返回空对象且不抛异常", () => {
		setupFakeElectron({ available: true });
		const out = encryptKeys("", "");
		expect(out.apiKey).toBeUndefined();
		expect(out.embeddingApiKey).toBeUndefined();
	});

	it("解密失败（本机无法读跨设备密文）→ hadFailure=true，值保持空字符串", () => {
		setupFakeElectron({ available: true, throwOnDecrypt: true });
		const dec = decryptKeys({ apiKey: "AAAA", embeddingApiKey: "BBBB" });
		expect(dec.apiKey).toBe("");
		expect(dec.embeddingApiKey).toBe("");
		expect(dec.hadFailure).toBe(true);
	});

	it("部分密文解密失败 → 成功的保留、失败的标 hadFailure", () => {
		// 第一次 decryptString 成功，第二次抛异常
		let n = 0;
		(globalThis as any).window = {
			require: () => ({
				safeStorage: {
					isEncryptionAvailable: () => true,
					encryptString: (p: string) => Buffer.from(p, "utf-8"),
					decryptString: (b: Buffer) => {
						n++;
						if (n === 2) throw new Error("bad");
						return b.toString("utf-8");
					},
				},
			}),
		};
		const plaintext = Buffer.from("live-key", "utf-8").toString("base64");
		const dec = decryptKeys({ apiKey: plaintext, embeddingApiKey: plaintext });
		expect(dec.apiKey).toBe("live-key");
		expect(dec.embeddingApiKey).toBe("");
		expect(dec.hadFailure).toBe(true);
	});

	it("环境无 electron → isEncryptionAvailable=false、加密抛 SecureStorageError", () => {
		(globalThis as any).window = { require: () => { throw new Error("not found"); } };
		expect(isEncryptionAvailable()).toBe(false);
		expect(() => encryptKeys("k", "")).toThrow(SecureStorageError);
	});
});

// 安全存储 — 使用 Electron safeStorage 加密 API Key
// 运行时 API Key 仍为明文（内存中），但持久化到 data.json 时加密
//
// 失败语义（重要）：
// - encryptValue / encryptKeys 加密失败抛 SecureStorageError，调用方负责回退策略
//   （通常是"保留明文、给用户明确告警"），绝不能既丢明文又没有密文
// - decryptValue / decryptKeys 解密失败返回 null / 空字段，调用方可据此检测"密文
//   存在但本机无法解密"的情况（如跨设备同步到加密不可用的环境）

interface SafeStorage {
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
	isEncryptionAvailable(): boolean;
}

export class SecureStorageError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = "SecureStorageError";
	}
}

function getSafeStorage(): SafeStorage | null {
	try {
		const electron = (window as any).require?.("electron");
		return electron?.safeStorage || null;
	} catch {
		return null;
	}
}

export function isEncryptionAvailable(): boolean {
	const ss = getSafeStorage();
	try {
		return ss ? ss.isEncryptionAvailable() : false;
	} catch {
		return false;
	}
}

export function encryptValue(plainText: string): string {
	if (!plainText) return "";
	const ss = getSafeStorage();
	if (!ss || !ss.isEncryptionAvailable()) {
		throw new SecureStorageError("Encryption not available on this platform");
	}
	try {
		const encrypted = ss.encryptString(plainText);
		return encrypted.toString("base64");
	} catch (e) {
		throw new SecureStorageError("Encryption failed", e);
	}
}

export function decryptValue(encryptedBase64: string): string | null {
	if (!encryptedBase64) return null;
	const ss = getSafeStorage();
	if (!ss) return null;
	try {
		const buf = Buffer.from(encryptedBase64, "base64");
		return ss.decryptString(buf);
	} catch {
		return null;
	}
}

export interface EncryptedKeys {
	apiKey?: string;
	embeddingApiKey?: string;
}

/**
 * 加密 API Keys。若加密不可用或失败，抛出 SecureStorageError。
 * 调用方在 catch 分支务必保留明文字段，不要删除 data.apiKey。
 */
export function encryptKeys(apiKey: string, embeddingApiKey: string): EncryptedKeys {
	const result: EncryptedKeys = {};
	if (apiKey) result.apiKey = encryptValue(apiKey);
	if (embeddingApiKey) result.embeddingApiKey = encryptValue(embeddingApiKey);
	return result;
}

export interface DecryptedKeys {
	apiKey: string;
	embeddingApiKey: string;
	hadFailure: boolean; // 存在密文但解密失败 → 提示用户
}

export function decryptKeys(encrypted: EncryptedKeys): DecryptedKeys {
	let hadFailure = false;
	let apiKey = "";
	let embeddingApiKey = "";

	if (encrypted.apiKey) {
		const d = decryptValue(encrypted.apiKey);
		if (d === null) hadFailure = true;
		else apiKey = d;
	}
	if (encrypted.embeddingApiKey) {
		const d = decryptValue(encrypted.embeddingApiKey);
		if (d === null) hadFailure = true;
		else embeddingApiKey = d;
	}

	return { apiKey, embeddingApiKey, hadFailure };
}

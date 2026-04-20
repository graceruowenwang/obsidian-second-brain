// 激活码签名工具
// 用法:
//   node generate-codes.mjs init          — 生成密钥对（只需一次）
//   node generate-codes.mjs [数量]        — 生成签名激活码（默认 1 个）
//
// 私钥保存在 local/.license-private-key（不要泄露！不要提交 git！）
// 公钥输出到屏幕，需要粘贴到 src/core/license.ts

import { generateKeyPairSync, sign, verify } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_DIR = join(__dirname, "local");
const PRIVATE_KEY_PATH = join(KEY_DIR, ".license-private-key");
const CODES_LOG = join(__dirname, "codes-log.txt");

function ensureDir() {
	if (!existsSync(KEY_DIR)) mkdirSync(KEY_DIR, { recursive: true });
}

function generateKeyPair() {
	ensureDir();
	const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 });
	console.log("密钥对已生成！");
	console.log(`私钥保存在: ${PRIVATE_KEY_PATH} (请勿泄露)`);
	console.log("\n将以下公钥复制到 src/core/license.ts 的 LICENSE_PUBLIC_KEY:\n");
	console.log(publicKey);
	console.log("");
}

function generateActivationCode(privateKey) {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const segs = [];
	for (let s = 0; s < 5; s++) {
		let seg = "";
		for (let i = 0; i < 4; i++) seg += chars[Math.floor(Math.random() * chars.length)];
		segs.push(seg);
	}
	const code = segs.join("-");

	// 签名
	const sig = sign(null, Buffer.from(code, "utf-8"), privateKey);
	// 编码为 base64url
	const sigB64 = sig.toString("base64url");

	return { code, signature: sigB64, full: `${code}.${sigB64}` };
}

function generateCodes(count) {
	if (!existsSync(PRIVATE_KEY_PATH)) {
		console.error("错误: 私钥不存在。请先运行: node generate-codes.mjs init");
		process.exit(1);
	}

	const privateKey = readFileSync(PRIVATE_KEY_PATH, "utf-8");
	const codes = [];

	for (let i = 0; i < count; i++) {
		const { code, full } = generateActivationCode(privateKey);
		codes.push(full);

		// 记录到日志
		const timestamp = new Date().toISOString();
		writeFileSync(CODES_LOG, `${timestamp}|${code}|unused\n`, { flag: "a" });
	}

	console.log(`已生成 ${count} 个激活码:\n`);
	for (const c of codes) {
		console.log(c);
	}
	console.log(`\n日志已追加到: ${CODES_LOG}`);
}

const cmd = process.argv[2];

if (cmd === "init") {
	if (existsSync(PRIVATE_KEY_PATH)) {
		console.log("密钥已存在，跳过。如需重新生成，请先删除 local/.license-private-key");
		process.exit(0);
	}
	generateKeyPair();
} else {
	const count = parseInt(cmd) || 1;
	generateCodes(count);
}

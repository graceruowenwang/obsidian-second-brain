// 指纹计算与 diff — 增量编译的基础

import type { CompileCache, Fingerprint } from "../types";

// fnv-1a 哈希：比 djb2 碰撞率更低，对长内容使用首尾采样
export function simpleHash(content: string): string {
	let h = 0x811c9dc5; // fnv-1a offset basis
	const sample = content.length <= 512
		? content
		: content.slice(0, 256) + content.slice(-256);
	for (let i = 0; i < sample.length; i++) {
		h ^= sample.charCodeAt(i);
		h = Math.imul(h, 0x01000193); // fnv-1a prime
	}
	return (h >>> 0).toString(36);
}

// 计算指纹（含内容长度 + 哈希 + 首 64 字符采样）
export function computeFingerprint(content: string): Fingerprint {
	const head = content.slice(0, 64);
	let headHash = 0x811c9dc5;
	for (let i = 0; i < head.length; i++) {
		headHash ^= head.charCodeAt(i);
		headHash = Math.imul(headHash, 0x01000193);
	}
	return {
		m: Date.now(),
		s: content.length,
		h: simpleHash(content),
		hh: (headHash >>> 0).toString(36),
	};
}

// Diff 指纹：返回变化和未变化的文件
export function diffFingerprints(
	files: Array<{ path: string; content: string }>,
	cache: CompileCache
): { changed: Array<{ path: string; content: string }>; unchanged: Array<{ path: string; content: string }> } {
	const changed: Array<{ path: string; content: string }> = [];
	const unchanged: Array<{ path: string; content: string }> = [];

	for (const f of files) {
		const cached = cache.fingerprints[f.path];
		if (!cached) {
			changed.push(f);
			continue;
		}
		if (cached.s !== f.content.length) {
			changed.push(f);
			continue;
		}
		const h = simpleHash(f.content);
		if (cached.h && cached.h !== h) {
			changed.push(f);
			continue;
		}
		// 首部采样校验（旧缓存无 hh 字段时跳过）
		if (cached.hh) {
			const head = f.content.slice(0, 64);
			let headHash = 0x811c9dc5;
			for (let i = 0; i < head.length; i++) {
				headHash ^= head.charCodeAt(i);
				headHash = Math.imul(headHash, 0x01000193);
			}
			if ((headHash >>> 0).toString(36) !== cached.hh) {
				changed.push(f);
				continue;
			}
		}
		unchanged.push(f);
	}

	return { changed, unchanged };
}

// 更新指纹
export function updateFingerprints(
	files: Array<{ path: string; content: string }>,
	cache: CompileCache
): void {
	for (const f of files) {
		cache.fingerprints[f.path] = computeFingerprint(f.content);
	}
}

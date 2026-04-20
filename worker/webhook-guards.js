/**
 * Webhook 防重放辅助：从 payload 提取事件时间，用于拒绝过期的异步通知重放。
 * 与 index.js 分离以便单测。
 */

/**
 * @param {unknown} v
 * @returns {number | null} Unix 毫秒时间戳
 */
function normalizeToMs(v) {
	if (v == null) return null;
	if (typeof v === "number" && Number.isFinite(v)) {
		if (v > 1e12) return v;
		if (v > 1e9) return v * 1000;
		return null;
	}
	if (typeof v === "string") {
		const s = v.trim();
		if (/^\d+$/.test(s)) {
			const n = parseInt(s, 10);
			if (n > 1e12) return n;
			if (n > 1e9) return n * 1000;
		}
	}
	return null;
}

/**
 * @param {any} body 已 JSON.parse 的 webhook 根对象
 * @returns {number | null} 事件时间（毫秒），未知则 null（调用方应跳过过期校验）
 */
export function extractWebhookEventTimeMs(body) {
	if (!body || typeof body !== "object") return null;
	const data = body.data && typeof body.data === "object" ? body.data : {};
	const candidates = [
		body.created_at,
		body.created,
		body.timestamp,
		body.time,
		body.ts,
		data.paid_at,
		data.created_at,
		data.updated_at,
		data.timestamp,
		data.time,
		data.ts,
	];
	for (const c of candidates) {
		const ms = normalizeToMs(c);
		if (ms != null) return ms;
	}
	return null;
}

/**
 * @param {any} body
 * @param {number} nowMs
 * @param {number} maxAgeMs 允许的最大时钟偏差（事件时间与「现在」之差）
 * @returns {boolean} true = 过旧，应拒绝
 */
export function isWebhookEventTooOld(body, nowMs, maxAgeMs) {
	const ts = extractWebhookEventTimeMs(body);
	if (ts == null) return false;
	return Math.abs(nowMs - ts) > maxAgeMs;
}

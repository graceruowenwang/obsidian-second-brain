// Second Brain License API — Cloudflare Worker
// 爱发电订单验证 + 自动生成 license key

const HEADERS = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

function json(data, status = 200) {
	return new Response(JSON.stringify(data), { status, headers: HEADERS });
}

function generateKey() {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const segs = [];
	for (let s = 0; s < 5; s++) {
		let seg = "";
		for (let i = 0; i < 4; i++) seg += chars[Math.floor(Math.random() * chars.length)];
		segs.push(seg);
	}
	return segs.join("-");
}

// 爱发电 API 签名: md5({token}params{params}ts{ts}user_id{user_id})
async function afdianSign(token, params, ts, userId) {
	const raw = `${token}params${params}ts${ts}user_id${userId}`;
	const encoder = new TextEncoder();
	const data = encoder.encode(raw);
	const buf = await crypto.subtle.digest("MD5", data);
	// Cloudflare Workers 不支持 MD5，用 Web Crypto 的 subtle 不行
	// 改用简单实现
	return md5Hex(raw);
}

// MD5 实现（Cloudflare Workers 不内置 MD5）
function md5Hex(str) {
	// 纯 JS MD5
	function md5cycle(x, k) {
		let a = x[0], b = x[1], c = x[2], d = x[3];
		a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
		c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
		a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
		c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
		a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
		c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
		a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
		c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
		a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
		c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
		a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
		c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
		a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
		c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
		a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
		c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
		a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
		c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
		a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
		c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
		a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
		c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
		a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
		c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
		a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
		c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
		a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
		c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
		a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
		c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
		a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
		c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
		x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
	}
	function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
	function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
	function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
	function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
	function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
	function md51(s) {
		let n = s.length, state = [1732584193, -271733879, -1732584194, 271733878], i;
		for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
		s = s.substring(i - 64);
		const tail = Array(16).fill(0);
		for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
		tail[i >> 2] |= 0x80 << ((i % 4) << 3);
		if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
		tail[14] = n * 8;
		md5cycle(state, tail);
		return state;
	}
	function md5blk(s) {
		const blk = Array(16).fill(0);
		for (let i = 0; i < 64; i += 4) blk[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
		return blk;
	}
	const hex_chr = "0123456789abcdef".split("");
	function rhex(n) { let s = ""; for (let j = 0; j < 4; j++) s += hex_chr[(n >> (j * 8 + 4)) & 0x0f] + hex_chr[(n >> (j * 8)) & 0x0f]; return s; }
	function hex(x) { return x.map(rhex).join(""); }
	function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
	return hex(md51(str));
}

// 查询爱发电订单
async function queryAfdianOrder(env, outTradeNo) {
	const userId = env.AFDIAN_USER_ID;
	const token = env.AFDIAN_TOKEN;
	const ts = Math.floor(Date.now() / 1000);

	// params 是 JSON 字符串
	const params = JSON.stringify({ out_trade_no: outTradeNo });

	const sign = await afdianSign(token, params, ts, userId);

	const resp = await fetch("https://afdian.net/api/open/query-order", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ user_id: userId, params, ts, sign }),
	});

	if (!resp.ok) throw new Error(`爱发电 API 返回 ${resp.status}`);
	return resp.json();
}

export default {
	async fetch(request, env) {
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: HEADERS });
		}
		if (request.method !== "POST") {
			return json({ error: "Method not allowed" }, 405);
		}

		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				case "/generate": return handleGenerate(request, env);
				case "/activate": return handleActivate(request, env);
				case "/activate-order": return handleActivateByOrder(request, env);
				case "/validate": return handleValidate(request, env);
				case "/deactivate": return handleDeactivate(request, env);
				case "/webhook/afdian": return handleAfdianWebhook(request, env);
				default: return json({ error: "Not found" }, 404);
			}
		} catch (e) {
			return json({ error: e.message || "Internal error" }, 500);
		}
	},
};

// POST /generate — 管理员手动生成 license key
async function handleGenerate(request, env) {
	const token = request.headers.get("X-Admin-Token");
	if (token !== env.ADMIN_TOKEN) return json({ error: "Unauthorized" }, 401);

	const body = await request.json().catch(() => ({}));
	const key = body.key || generateKey();

	const existing = await env.LICENSE.get(`license:${key}`, "json");
	if (existing) return json({ error: "Key already exists" }, 409);

	await env.LICENSE.put(`license:${key}`, JSON.stringify({
		status: "inactive",
		instanceId: null,
		activatedAt: null,
		email: body.email || null,
		plan: "pro",
		createdAt: new Date().toISOString(),
	}));

	return json({ key });
}

// POST /activate — 插件调用：用已有的 license key 激活
async function handleActivate(request, env) {
	const body = await request.json().catch(() => ({}));
	const licenseKey = body.license_key;
	const instanceName = body.instance_name;

	if (!licenseKey || !instanceName) return json({ error: "Missing fields" }, 400);

	const data = await env.LICENSE.get(`license:${licenseKey}`, "json");
	if (!data) return json({ activated: false, error: "Invalid license key" }, 404);

	if (data.status === "active" && data.instanceId && data.instanceId !== instanceName) {
		return json({ activated: false, error: "Already activated on another device" }, 403);
	}

	data.status = "active";
	data.instanceId = instanceName;
	data.activatedAt = data.activatedAt || new Date().toISOString();

	await env.LICENSE.put(`license:${licenseKey}`, JSON.stringify(data));
	await env.LICENSE.put(`instance:${instanceName}`, JSON.stringify({ key: licenseKey }));

	return json({
		activated: true,
		license_key: { status: "active" },
		instance: { id: instanceName },
	});
}

// POST /activate-order — 插件调用：用爱发电订单号激活
async function handleActivateByOrder(request, env) {
	const body = await request.json().catch(() => ({}));
	const orderId = (body.order_id || "").trim();
	const instanceName = (body.instance_name || "").trim();

	if (!orderId || !instanceName) return json({ error: "Missing order_id or instance_name" }, 400);

	// 检查该订单是否已生成过 key
	const existingMapping = await env.LICENSE.get(`order:${orderId}`, "json");
	if (existingMapping) {
		// 已有 key，直接用现有 key 激活
		const data = await env.LICENSE.get(`license:${existingMapping.key}`, "json");
		if (!data) {
			// 数据异常，清理后重新走流程
			await env.LICENSE.delete(`order:${orderId}`);
		} else {
			// 同一设备可以重复激活，不同设备则拒绝
			if (data.status === "active" && data.instanceId && data.instanceId !== instanceName) {
				return json({ activated: false, error: "Already activated on another device" }, 403);
			}
			data.status = "active";
			data.instanceId = instanceName;
			data.activatedAt = data.activatedAt || new Date().toISOString();
			await env.LICENSE.put(`license:${existingMapping.key}`, JSON.stringify(data));
			await env.LICENSE.put(`instance:${instanceName}`, JSON.stringify({ key: existingMapping.key }));

			return json({
				activated: true,
				license_key: existingMapping.key,
			});
		}
	}

	// 调用爱发电 API 验证订单
	let orderData;
	try {
		orderData = await queryAfdianOrder(env, orderId);
	} catch (e) {
		return json({ activated: false, error: "Failed to verify order: " + e.message }, 502);
	}

	// 爱发电返回格式: { ec: 200, data: { list: [...] } }
	if (!orderData || orderData.ec !== 200 || !orderData.data || !orderData.data.list || orderData.data.list.length === 0) {
		return json({ activated: false, error: "Order not found" }, 404);
	}

	const order = orderData.data.list[0];

	// 验证订单状态 (2 = 已支付)
	if (order.status !== 2) {
		return json({ activated: false, error: "Order not paid" }, 400);
	}

	// 验证金额 (¥30 = 3000 分，或根据你的定价调整)
	const expectedAmount = parseInt(env.EXPECTED_AMOUNT || "3000");
	if (order.total_amount && parseInt(order.total_amount) < expectedAmount) {
		return json({ activated: false, error: "Order amount mismatch" }, 400);
	}

	// 生成 license key
	const key = generateKey();
	await env.LICENSE.put(`license:${key}`, JSON.stringify({
		status: "active",
		instanceId: instanceName,
		activatedAt: new Date().toISOString(),
		email: null,
		plan: "pro",
		createdAt: new Date().toISOString(),
		afdianOrderId: orderId,
	}));

	// 记录订单 → key 映射，避免重复生成
	await env.LICENSE.put(`order:${orderId}`, JSON.stringify({ key }));
	await env.LICENSE.put(`instance:${instanceName}`, JSON.stringify({ key }));

	return json({
		activated: true,
		license_key: key,
	});
}

// POST /validate — 插件定期验证
async function handleValidate(request, env) {
	const body = await request.json().catch(() => ({}));
	const licenseKey = body.license_key;
	const instanceId = body.instance_id || null;

	if (!licenseKey) return json({ valid: false, error: "Missing license_key" }, 400);

	const data = await env.LICENSE.get(`license:${licenseKey}`, "json");
	if (!data) return json({ valid: false, error: "Invalid license key" });
	if (data.status !== "active") return json({ valid: false, error: "Not activated" });
	if (instanceId && data.instanceId !== instanceId) {
		return json({ valid: false, error: "Instance mismatch" });
	}

	return json({
		valid: true,
		license_key: { status: "active" },
		instance: { id: data.instanceId },
	});
}

// POST /deactivate — 插件调用：停用（换设备）
async function handleDeactivate(request, env) {
	const body = await request.json().catch(() => ({}));
	const licenseKey = body.license_key;
	const instanceId = body.instance_id;

	if (!licenseKey || !instanceId) return json({ error: "Missing fields" }, 400);

	const data = await env.LICENSE.get(`license:${licenseKey}`, "json");
	if (!data) return json({ error: "Invalid license key" }, 404);
	if (data.instanceId !== instanceId) return json({ error: "Instance mismatch" }, 403);

	data.status = "inactive";
	data.instanceId = null;

	await env.LICENSE.put(`license:${licenseKey}`, JSON.stringify(data));
	await env.LICENSE.delete(`instance:${instanceId}`);

	return json({ deactivated: true });
}

// POST /webhook/afdian — 爱发电支付回调，自动生成 key
async function handleAfdianWebhook(request, env) {
	const body = await request.json().catch(() => ({}));

	// 爱发电 webhook 格式：{ ec: 200, data: { order: {...}, ... } }
	if (body.ec !== 200 || !body.data) {
		return json({ error: "Invalid webhook payload" }, 400);
	}

	const order = body.data.order || body.data;
	const orderId = order.order_id || order.out_trade_no;

	// 检查是否已处理过
	const existingMapping = await env.LICENSE.get(`order:${orderId}`, "json");
	if (existingMapping) {
		return json({ ec: 200, key: existingMapping.key, message: `License Key: ${existingMapping.key}` });
	}

	// 生成 license key
	const key = generateKey();
	await env.LICENSE.put(`license:${key}`, JSON.stringify({
		status: "inactive",
		instanceId: null,
		activatedAt: null,
		email: null,
		plan: "pro",
		createdAt: new Date().toISOString(),
		afdianOrderId: orderId,
	}));

	await env.LICENSE.put(`order:${orderId}`, JSON.stringify({ key }));

	return json({ ec: 200, key, message: `License Key: ${key}` });
}

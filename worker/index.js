// Second Brain License API — Cloudflare Worker
// 激活码管理 + 面包多支付集成

const CORS_BASE = {
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

const HEADERS_PUBLIC = {
	"Content-Type": "application/json",
	"Access-Control-Allow-Origin": "*",
	...CORS_BASE,
};

// 管理接口不使用 *：降低浏览器端被第三方页面滥用的面（仍须带 X-Admin-Token）
const HEADERS_ADMIN = {
	"Content-Type": "application/json",
	...CORS_BASE,
};

function isAdminApiPath(pathname) {
	return pathname === "/generate" || pathname.startsWith("/admin/");
}

function json(data, status = 200, headers = HEADERS_PUBLIC) {
	return new Response(JSON.stringify(data), { status, headers });
}

function jsonAdmin(data, status = 200) {
	return json(data, status, HEADERS_ADMIN);
}

function generateKey() {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const segs = [];
	const rand = new Uint32Array(20);
	crypto.getRandomValues(rand);
	for (let s = 0; s < 5; s++) {
		let seg = "";
		for (let i = 0; i < 4; i++) seg += chars[rand[s * 4 + i] % chars.length];
		segs.push(seg);
	}
	return segs.join("-");
}

// ---- HMAC 辅助 ----

async function hmacSha256Hex(secret, message) {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
	return Array.from(new Uint8Array(sig))
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");
}

// 常数时间字符串比较，规避 timing side-channel
function timingSafeEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// ---- 速率限制（按 IP + 路径，KV 滚动计数窗口）----
// 对 /activate /validate 启用，防止激活码枚举爆破。
// 每分钟窗口，默认 20 次；可通过 env.RATE_LIMIT_PER_MIN 覆盖。

function clientIp(request) {
	return request.headers.get("CF-Connecting-IP")
		|| request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim()
		|| "unknown";
}

async function rateLimit(request, env, bucket) {
	const limit = parseInt(env.RATE_LIMIT_PER_MIN || "20", 10);
	const ip = clientIp(request);
	const windowKey = Math.floor(Date.now() / 60000);
	const kvKey = `rl:${bucket}:${ip}:${windowKey}`;
	const curr = parseInt((await env.LICENSE.get(kvKey)) || "0", 10);
	if (curr >= limit) return false;
	await env.LICENSE.put(kvKey, String(curr + 1), { expirationTtl: 120 });
	return true;
}

/**
 * 校验面包多 Webhook 签名。
 *
 * 面包多官方的签名 header 和算法请以最新文档为准；下述实现做了两个常见假设：
 *   1) header 名为 `X-Signature`（若不同，改下面这行即可）
 *   2) 签名方式为 HMAC-SHA256(secret, raw_body) 的十六进制
 *
 * 返回 true 仅当签名正确且 secret 已配置。secret 未配置时一律返回 false —— 拒绝
 * 优先于"警告后放过"，避免开发期误配置导致生产被伪造 charge_succeeded 攻击。
 */
async function verifyMbdSignature(request, rawBody, env) {
	if (!env.MBD_WEBHOOK_SECRET) return false;
	const sig = request.headers.get("X-Signature") || request.headers.get("x-signature");
	if (!sig) return false;
	const expected = await hmacSha256Hex(env.MBD_WEBHOOK_SECRET, rawBody);
	return timingSafeEqual(sig.toLowerCase(), expected.toLowerCase());
}

export default {
	async fetch(request, env) {
		if (request.method === "OPTIONS") {
			const pathname = new URL(request.url).pathname;
			const h = isAdminApiPath(pathname) ? HEADERS_ADMIN : HEADERS_PUBLIC;
			return new Response(null, { status: 204, headers: h });
		}

		const url = new URL(request.url);
		try {
			switch (url.pathname) {
				// --- 面包多支付 Webhook ---
				case "/webhook/mbd":
					return handleMbdWebhook(request, env);

				// --- 支付引导页 ---
				case "/pay/page":
					return handlePayPage(env, url);

				// --- 订单状态查询 ---
				case "/pay/status":
					return handlePayStatus(env, url);

				// --- 激活码管理 API ---
				case "/generate": return handleGenerate(request, env);
				case "/activate": {
					if (!await rateLimit(request, env, "activate")) {
						return json({ error: "Rate limit exceeded" }, 429);
					}
					return handleActivate(request, env);
				}
				case "/validate": {
					if (!await rateLimit(request, env, "validate")) {
						return json({ error: "Rate limit exceeded" }, 429);
					}
					return handleValidate(request, env);
				}
				case "/deactivate": return handleDeactivate(request, env);

				// --- 管理后台 API ---
				case "/admin/list": return handleAdminList(request, env, url);
				case "/admin/revoke": return handleAdminRevoke(request, env);
				case "/admin/stats": return handleAdminStats(request, env);

				// --- 根路径重定向到支付页 ---
				case "/":
					return Response.redirect(`${url.origin}/pay/page`, 302);

				default: return json({ error: "Not found" }, 404);
			}
		} catch (e) {
			return json({ error: e.message || "Internal error" }, 500);
		}
	},
};

// ============ 面包多支付 ============

// POST /webhook/mbd — 面包多支付成功异步通知
async function handleMbdWebhook(request, env) {
	// 必须校验签名，否则攻击者可伪造 charge_succeeded 无限签发激活码
	const rawBody = await request.text();
	const ok = await verifyMbdSignature(request, rawBody, env);
	if (!ok) {
		return json({ error: "Invalid signature" }, 401);
	}

	let body;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return json({ error: "Invalid JSON" }, 400);
	}

	if (body.type !== "charge_succeeded") {
		return json({ ok: true });
	}

	const data = body.data || {};
	const { out_trade_no, amount, description, openid, charge_id, payway } = data;
	if (!out_trade_no) return json({ error: "Missing out_trade_no" }, 400);

	// 验证金额: 30 CNY = 3000 分
	if (amount !== 3000) {
		return json({ error: "Invalid amount" }, 400);
	}

	// 幂等检查: 订单已处理过则直接返回
	const existing = await env.LICENSE.get(`order:${out_trade_no}`, "json");
	if (existing && existing.key) {
		return json({ ok: true, key: existing.key });
	}

	// 生成激活码
	const key = generateKey();

	// 存储 订单号 → 激活码 映射
	await env.LICENSE.put(`order:${out_trade_no}`, JSON.stringify({
		status: "paid",
		key,
		amount,
		description,
		openid: openid || null,
		chargeId: charge_id || null,
		payway: payway || null,
		createdAt: new Date().toISOString(),
	}));

	// 存储激活码
	await env.LICENSE.put(`license:${key}`, JSON.stringify({
		status: "inactive",
		instanceId: null,
		activatedAt: null,
		email: null,
		plan: "pro",
		createdAt: new Date().toISOString(),
		source: "mbd",
		mbdOrderNo: out_trade_no,
	}));

	return json({ ok: true, key });
}

// GET /pay/status?order=xxx — 查询订单状态
//
// 注意：本端点只负责"读"和"兜底补录"。正常签发路径在 /webhook/mbd。
// 兜底补录在并发下可能被多个轮询同时触发，因此在 put 前做一次"双读"检测，
// 尽力避免同一订单签发两个激活码。KV 非严格 CAS，仍有极小窗口，但已远优于直接覆盖。
async function handlePayStatus(env, url) {
	const orderNo = url.searchParams.get("order");
	if (!orderNo) return json({ error: "Missing order parameter" }, 400);

	const order = await env.LICENSE.get(`order:${orderNo}`, "json");
	if (!order) return json({ status: "not_found", key: null });
	if (order.key) return json({ status: order.status || "paid", key: order.key });

	// 本地无 key，且面包多配置齐全 → 尝试补录
	if (env.MBD_APP_ID) {
		try {
			const verifyResp = await fetch("https://newapi.mbd.pub/release/main/search_order", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ out_trade_no: orderNo }),
			});
			const verifyData = await verifyResp.json();
			if (verifyData.state === "1" && verifyData.amount === 3000) {
				// 关键：put 前再读一次，若并发轮询已经写入 key，直接返回它而不是覆盖
				const recheck = await env.LICENSE.get(`order:${orderNo}`, "json");
				if (recheck && recheck.key) {
					return json({ status: "paid", key: recheck.key });
				}
				const key = generateKey();
				await env.LICENSE.put(`order:${orderNo}`, JSON.stringify({
					status: "paid",
					key,
					amount: verifyData.amount,
					createdAt: new Date().toISOString(),
					source: "pay-status-fallback",
				}));
				await env.LICENSE.put(`license:${key}`, JSON.stringify({
					status: "inactive",
					instanceId: null,
					activatedAt: null,
					plan: "pro",
					createdAt: new Date().toISOString(),
					source: "mbd",
					mbdOrderNo: orderNo,
				}));
				return json({ status: "paid", key });
			}
		} catch (_) {
			// 面包多 API 查询失败，返回本地数据
		}
	}

	return json({
		status: order.status || "unknown",
		key: null,
	});
}

// GET /pay/page — 支付引导页
function handlePayPage(env, url) {
	const productUrl = env.MBD_PRODUCT_URL || "";
	const orderParam = url.searchParams.get("order") || "";
	const autoCheck = orderParam ? "true" : "false";

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Second Brain Pro - 购买激活码</title>
<style>
:root { --bg: #f8f9fa; --card: #fff; --border: #e1e4e8; --accent: #6366f1; --text: #24292f; --muted: #656d76; --ok: #1a7f37; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); padding: 2rem 1rem; max-width: 520px; margin: 0 auto; }
h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
.subtitle { color: var(--muted); font-size: 0.85rem; margin-bottom: 1.5rem; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
h2 { font-size: 1rem; margin-bottom: 0.75rem; color: var(--muted); }
.price { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
.price-note { font-size: 0.8rem; color: var(--muted); margin-top: 0.25rem; }
.btn { display: inline-block; padding: 0.65rem 1.5rem; border-radius: 8px; font-size: 0.9rem; font-weight: 600; text-decoration: none; cursor: pointer; border: none; margin-top: 0.75rem; }
.btn-primary { background: var(--accent); color: #fff; }
.btn-outline { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
input { width: 100%; padding: 0.55rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.85rem; margin-bottom: 0.5rem; }
.result { margin-top: 0.75rem; padding: 0.75rem; border-radius: 6px; font-size: 0.85rem; }
.result-success { background: #dafbe1; color: var(--ok); }
.result-error { background: #fff8c5; color: #9a6700; }
.key-code { font-family: 'SF Mono', Monaco, monospace; font-size: 1rem; font-weight: 600; letter-spacing: 0.5px; word-break: break-all; background: #f0f0f0; padding: 0.5rem; border-radius: 4px; margin-top: 0.5rem; user-select: all; }
.steps { font-size: 0.82rem; color: var(--muted); line-height: 1.6; }
.steps ol { padding-left: 1.2rem; }
</style>
</head>
<body>

<h1>Second Brain Pro</h1>
<p class="subtitle">Obsidian 知识库编译 + AI 对话 + 多模型支持</p>

<div class="card">
  <h2>购买激活码</h2>
  <div class="price">30 CNY / $5 USD</div>
  <div class="price-note">买断制，一次购买永久使用</div>
  ${productUrl ? `<a href="${productUrl}" class="btn btn-primary" target="_blank">前往支付</a>` : `<p style="color:var(--muted);font-size:0.82rem;margin-top:0.5rem;">支付链接暂未配置，请联系开发者。</p>`}
</div>

<div class="card">
  <h2>查询激活码</h2>
  <p style="font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem;">支付成功后，输入订单号获取激活码</p>
  <input type="text" id="orderInput" placeholder="输入面包多订单号" value="${orderParam}" />
  <button class="btn btn-outline" onclick="checkOrder()">查询</button>
  <div id="result"></div>
</div>

<div class="card steps">
  <h2>使用说明</h2>
  <ol>
    <li>点击「前往支付」完成付款</li>
    <li>付款成功后复制订单号</li>
    <li>在上方输入订单号查询激活码</li>
    <li>打开 Obsidian → Second Brain 设置 → License 管理</li>
    <li>粘贴激活码，点击激活</li>
  </ol>
</div>

<script>
const autoCheck = ${autoCheck};

async function checkOrder() {
  const order = document.getElementById('orderInput').value.trim();
  const result = document.getElementById('result');
  if (!order) { result.innerHTML = '<div class="result result-error">请输入订单号</div>'; return; }
  result.innerHTML = '<div class="result">查询中...</div>';
  try {
    const resp = await fetch('/pay/status?order=' + encodeURIComponent(order));
    const data = await resp.json();
    if (data.key) {
      result.innerHTML = '<div class="result result-success">支付成功！您的激活码：<div class="key-code">' + data.key + '</div></div>';
    } else {
      result.innerHTML = '<div class="result result-error">' + (data.status === 'not_found' ? '订单未找到，请确认订单号是否正确' : '订单尚未支付，请完成付款后重试') + '</div>';
    }
  } catch (e) {
    result.innerHTML = '<div class="result result-error">查询失败: ' + e.message + '</div>';
  }
}

if (autoCheck) {
  checkOrder();
  let polls = 0;
  const timer = setInterval(async () => {
    polls++;
    if (polls >= 20) { clearInterval(timer); return; }
    const order = document.getElementById('orderInput').value.trim();
    if (!order) { clearInterval(timer); return; }
    try {
      const resp = await fetch('/pay/status?order=' + encodeURIComponent(order));
      const data = await resp.json();
      if (data.key) {
        document.getElementById('result').innerHTML = '<div class="result result-success">支付成功！您的激活码：<div class="key-code">' + data.key + '</div></div>';
        clearInterval(timer);
      }
    } catch (_) {}
  }, 3000);
}
</script>
</body>
</html>`;

	return new Response(html, {
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

// ============ 激活码管理 ============

async function handleGenerate(request, env) {
	const token = request.headers.get("X-Admin-Token");
	if (token !== env.ADMIN_TOKEN) return jsonAdmin({ error: "Unauthorized" }, 401);

	const body = await request.json().catch(() => ({}));
	const key = body.key || generateKey();

	const existing = await env.LICENSE.get(`license:${key}`, "json");
	if (existing) return jsonAdmin({ error: "Key already exists" }, 409);

	await env.LICENSE.put(`license:${key}`, JSON.stringify({
		status: "inactive",
		instanceId: null,
		activatedAt: null,
		email: body.email || null,
		plan: "pro",
		createdAt: new Date().toISOString(),
		source: body.source || "admin",
	}));

	return jsonAdmin({ key });
}

async function handleActivate(request, env) {
	const body = await request.json().catch(() => ({}));
	const licenseKey = (body.license_key || "").trim().toUpperCase();
	const instanceName = (body.instance_name || "").trim();

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

// ============ 管理后台 API ============

async function handleAdminList(request, env, url) {
	const token = request.headers.get("X-Admin-Token");
	if (token !== env.ADMIN_TOKEN) return jsonAdmin({ error: "Unauthorized" }, 401);

	const prefix = url.searchParams.get("prefix") || "license:";
	const cursor = url.searchParams.get("cursor") || undefined;
	const limit = parseInt(url.searchParams.get("limit") || "50");

	const result = await env.LICENSE.list({ prefix, cursor, limit });

	const keys = [];
	for (const key of result.keys) {
		const data = await env.LICENSE.get(key.name, "json");
		keys.push({
			key: key.name.replace("license:", ""),
			...data,
		});
	}

	return jsonAdmin({
		keys,
		cursor: result.cursor || null,
		list_complete: result.list_complete,
	});
}

async function handleAdminRevoke(request, env) {
	const token = request.headers.get("X-Admin-Token");
	if (token !== env.ADMIN_TOKEN) return jsonAdmin({ error: "Unauthorized" }, 401);

	const body = await request.json().catch(() => ({}));
	const licenseKey = (body.key || "").trim().toUpperCase();
	if (!licenseKey) return jsonAdmin({ error: "Missing key" }, 400);

	const data = await env.LICENSE.get(`license:${licenseKey}`, "json");
	if (!data) return jsonAdmin({ error: "Key not found" }, 404);

	if (data.instanceId) {
		await env.LICENSE.delete(`instance:${data.instanceId}`);
	}

	await env.LICENSE.delete(`license:${licenseKey}`);
	return jsonAdmin({ revoked: true, key: licenseKey });
}

async function handleAdminStats(request, env) {
	const token = request.headers.get("X-Admin-Token");
	if (token !== env.ADMIN_TOKEN) return jsonAdmin({ error: "Unauthorized" }, 401);

	let total = 0, active = 0, inactive = 0;
	let cursor = undefined;

	do {
		const result = await env.LICENSE.list({ prefix: "license:", cursor });
		total += result.keys.length;
		for (const key of result.keys) {
			const data = await env.LICENSE.get(key.name, "json");
			if (data && data.status === "active") active++;
			else inactive++;
		}
		cursor = result.list_complete ? undefined : result.cursor;
	} while (cursor);

	return jsonAdmin({ total, active, inactive });
}

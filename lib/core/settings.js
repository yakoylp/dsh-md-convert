/**
 * dsh-md-convert — 插件设置面(host 侧)
 *
 * 给浏览器半区的设置卡提供一个小接口,读写本插件的 `cache` 配置:
 *   GET  /dsh-md-convert/api/v1/settings   读取配置 + 生效目录 + 缓存统计
 *   POST /dsh-md-convert/api/v1/settings   写入配置(经 configEditor 持久化到 profile patch)
 *
 * 路径刻意避开 `/api` 前缀:宿主的连接栅栏接管整段 /api(未带会话一律 401),
 * 非 /api 前缀的 exact 路由才会直达处理器(与 dsh-market 的做法一致)。
 *
 * 没有 webServer(独立 CLI、headless)时静默不注册。configEditor 与配置行在**请求时**解析,
 * 因此不依赖插件激活顺序。写入只接受 `cache` 段;POST 要求 application/json 且同源。
 */
import { resolveCacheDir, cacheStatus } from "./cache.js";

const ROUTE_PATH = "/dsh-md-convert/api/v1/settings";

/** 缓存配置默认值(与 convert.js 的 DEFAULT_OPTS.cache 保持一致) */
const CACHE_DEFAULTS = { enabled: true, dir: "", maxBytes: 2 * 1024 * 1024 * 1024, maxAgeDays: 0 };

function sendJson(response, status, payload) {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
	});
	response.end(JSON.stringify(payload));
}

/** 读取有上限的 JSON 请求体 */
function readJsonBody(request, limit = 64 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("请求体过大"));
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		request.on("error", reject);
	});
}

/** 归一化 cache 配置:只接受已知字段,非法值回落到 base */
function normalizeCache(input, base = CACHE_DEFAULTS) {
	const src = { ...base, ...(input && typeof input === "object" ? input : {}) };
	const dir = typeof src.dir === "string" ? src.dir.trim() : base.dir;
	const enabled = typeof src.enabled === "boolean" ? src.enabled : base.enabled;
	const maxBytes = Number(src.maxBytes);
	const maxAgeDays = Number(src.maxAgeDays);
	return {
		enabled,
		dir,
		maxBytes: Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : base.maxBytes,
		maxAgeDays: Number.isFinite(maxAgeDays) && maxAgeDays >= 0 ? Math.floor(maxAgeDays) : base.maxAgeDays,
	};
}

/** 只放行同源请求(无 Origin 视为非浏览器调用) */
function sameOrigin(request) {
	const origin = request.headers?.origin;
	if (typeof origin !== "string" || origin === "") return true;
	try {
		return new URL(origin).host === request.headers?.host;
	} catch {
		return false;
	}
}

/**
 * 解析本插件的 Loader 配置行:优先 fiber.entry,回退到 loader 里按 patch id 查找。
 * @param {object} ctx
 * @returns {object | undefined}
 */
function resolveEntry(ctx) {
	const direct = ctx.fiber?.entry;
	if (direct) return direct;
	try {
		const entries = ctx.get?.("loader")?.entries?.() ?? [];
		for (const entry of entries) {
			if (entry?.options?.id === "dsh-md-convert" || entry?.id === "include:dsh-md-convert") return entry;
		}
	} catch {
		/* 忽略 */
	}
	return undefined;
}

/**
 * 从插件 config 取 cache 段(带默认值)。
 * @param {object} config
 * @returns {{ enabled: boolean, dir: string, maxBytes: number, maxAgeDays: number }}
 */
export function cacheSettingsFrom(config) {
	return normalizeCache(config?.cache, CACHE_DEFAULTS);
}

/**
 * 注册设置接口;缺少 webServer 时返回空 disposer。
 * @param {object} ctx 插件上下文
 * @param {() => object} readConfig 读取当前插件 config
 * @returns {() => void}
 */
export function registerSettingsRoute(ctx, readConfig) {
	const server = ctx.get?.("webServer");
	if (!server) return () => {};

	const handle = async (request, response) => {
		try {
			const method = request.method ?? "GET";
			if (method === "GET" || method === "HEAD") {
				const cache = cacheSettingsFrom(readConfig());
				const effectiveDir = resolveCacheDir(cache.dir);
				sendJson(response, 200, {
					ok: true,
					cache,
					effectiveDir,
					status: cacheStatus(effectiveDir),
				});
				return;
			}
			if (method !== "POST") {
				sendJson(response, 405, { ok: false, error: "不支持的方法" });
				return;
			}
			if (!sameOrigin(request)) {
				sendJson(response, 403, { ok: false, error: "跨站请求已被拒绝" });
				return;
			}
			const contentType = String(request.headers?.["content-type"] ?? "");
			if (!contentType.includes("application/json")) {
				sendJson(response, 415, { ok: false, error: "需要 application/json" });
				return;
			}
			const editor = ctx.get?.("configEditor");
			if (!editor) {
				sendJson(response, 500, { ok: false, error: "当前 profile 没有 configEditor,无法保存配置" });
				return;
			}
			const entry = resolveEntry(ctx);
			if (!entry) {
				sendJson(response, 500, { ok: false, error: "找不到本插件的配置行,无法保存配置" });
				return;
			}
			const body = await readJsonBody(request);
			const next = normalizeCache(body?.cache, cacheSettingsFrom(readConfig()));
			await editor.edit(entry, (current) => ({
				...current,
				cache: { ...(current?.cache && typeof current.cache === "object" ? current.cache : {}), ...next },
			}));
			sendJson(response, 200, { ok: true, cache: next, effectiveDir: resolveCacheDir(next.dir) });
		} catch (e) {
			sendJson(response, 500, { ok: false, error: e?.message ?? String(e) });
		}
	};

	try {
		return server.register({ kind: "exact", path: ROUTE_PATH, handler: handle });
	} catch {
		return () => {};
	}
}

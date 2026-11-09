/**
 * settings.js 单元测试:设置接口的读取、写入、同源与内容类型校验,以及缺依赖时的降级。
 * 用假的 http request/response,不启动真实服务、不碰真实配置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerSettingsRoute, cacheSettingsFrom } from "../lib/core/settings.js";

function makeRequest({ method = "GET", headers = {}, body } = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = headers;
	process.nextTick(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body), "utf8"));
		req.emit("end");
	});
	return req;
}

function makeResponse() {
	return {
		statusCode: 0,
		headers: null,
		body: "",
		writeHead(code, headers) {
			this.statusCode = code;
			this.headers = headers;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
		},
	};
}

function makeHost({ config = {} } = {}) {
	let route = null;
	const edits = [];
	const ctx = {
		get(name) {
			if (name === "webServer") {
				return {
					register(r) {
						route = r;
						return () => {};
					},
				};
			}
			if (name === "configEditor") {
				return {
					async edit(entry, change) {
						edits.push({ entry, next: change({ cache: { dir: "old" } }) });
					},
				};
			}
			return undefined;
		},
		fiber: { entry: { id: "include:dsh-md-convert" } },
	};
	const dispose = registerSettingsRoute(ctx, () => config);
	return { route, edits, dispose };
}

test("GET 返回缓存配置、生效目录与统计", async () => {
	const { route } = makeHost({ config: { cache: { enabled: false, dir: "" } } });
	const res = makeResponse();
	await route.handler(makeRequest({ method: "GET" }), res);
	assert.equal(res.statusCode, 200);
	const data = JSON.parse(res.body);
	assert.equal(data.ok, true);
	assert.equal(data.cache.enabled, false);
	assert.ok(typeof data.effectiveDir === "string" && data.effectiveDir.endsWith("md-convert-cache"));
	assert.ok(typeof data.status.entries === "number");
});

test("POST 经 configEditor 写入 cache 配置", async () => {
	const { route, edits } = makeHost({ config: {} });
	const res = makeResponse();
	await route.handler(
		makeRequest({
			method: "POST",
			headers: { "content-type": "application/json", host: "127.0.0.1:3000" },
			body: { cache: { dir: "D:/cache", enabled: false, maxBytes: 1024, maxAgeDays: 7 } },
		}),
		res,
	);
	assert.equal(res.statusCode, 200);
	const data = JSON.parse(res.body);
	assert.equal(data.cache.dir, "D:/cache");
	assert.equal(data.cache.enabled, false);
	assert.equal(edits.length, 1);
	assert.equal(edits[0].next.cache.dir, "D:/cache");
	assert.equal(edits[0].next.cache.maxAgeDays, 7);
});

test("POST 拒绝非 JSON 内容类型与跨站来源", async () => {
	const { route } = makeHost();
	const plain = makeResponse();
	await route.handler(
		makeRequest({ method: "POST", headers: { "content-type": "text/plain" }, body: {} }),
		plain,
	);
	assert.equal(plain.statusCode, 415);

	const cross = makeResponse();
	await route.handler(
		makeRequest({
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example", host: "127.0.0.1:3000" },
			body: { cache: { dir: "D:/x" } },
		}),
		cross,
	);
	assert.equal(cross.statusCode, 403);
});

test("缺少 webServer / configEditor 时静默跳过", () => {
	const dispose = registerSettingsRoute({ get: () => undefined, fiber: {} }, () => ({}));
	assert.equal(typeof dispose, "function");
	dispose();
});

test("cacheSettingsFrom 只接受合法字段并补默认值", () => {
	assert.deepEqual(cacheSettingsFrom({}), {
		enabled: true,
		dir: "",
		maxBytes: 2 * 1024 * 1024 * 1024,
		maxAgeDays: 0,
	});
	const bad = cacheSettingsFrom({ cache: { dir: 123, maxBytes: -1, maxAgeDays: "x" } });
	assert.equal(bad.dir, "");
	assert.equal(bad.maxBytes, 2 * 1024 * 1024 * 1024);
	assert.equal(bad.maxAgeDays, 0);
});

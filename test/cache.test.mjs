/**
 * cache.js 单元测试:内容寻址键、命中/失效、损坏降级、清理、目录优先级。
 * 全部使用临时目录,绝不触碰真实缓存目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	cacheKey,
	readCache,
	writeCache,
	cacheStatus,
	cacheClear,
	cachePrune,
	resolveCacheDir,
} from "../lib/core/cache.js";
import { convertFile } from "../lib/core/convert.js";

function tempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

test("cacheKey:内容变化与 PDF 选项变化都会换键", async () => {
	const dir = tempDir("dsh-md-cache-key-");
	try {
		const src = join(dir, "a.txt");
		writeFileSync(src, "hello", "utf8");
		const k1 = await cacheKey(src, "pdf", { forceOcr: false });
		const k2 = await cacheKey(src, "pdf", { forceOcr: false });
		assert.equal(k1.key, k2.key);
		const k3 = await cacheKey(src, "pdf", { forceOcr: true });
		assert.notEqual(k1.key, k3.key);
		writeFileSync(src, "hello world", "utf8");
		const k4 = await cacheKey(src, "pdf", { forceOcr: false });
		assert.notEqual(k1.key, k4.key);
		assert.equal(await cacheKey(join(dir, "missing.txt"), "txt", {}), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("convertFile:第二次调用命中缓存,内容变化后失效", async () => {
	const root = tempDir("dsh-md-cache-int-");
	const cacheDir = join(root, "cache");
	const outDir = join(root, "out");
	const src = join(root, "note.txt");
	try {
		writeFileSync(src, "第一版内容", "utf8");
		const first = await convertFile(src, { outDir, cache: { enabled: true, dir: cacheDir } });
		assert.equal(first.ok, true);
		assert.equal(first.cached, false);
		const firstMd = readFileSync(first.outFile, "utf8");

		const second = await convertFile(src, { outDir, cache: { enabled: true, dir: cacheDir } });
		assert.equal(second.ok, true);
		assert.equal(second.cached, true);
		assert.ok(second.cachedAt);
		assert.equal(readFileSync(second.outFile, "utf8"), firstMd);

		writeFileSync(src, "第二版内容", "utf8");
		const third = await convertFile(src, { outDir, cache: { enabled: true, dir: cacheDir } });
		assert.equal(third.ok, true);
		assert.equal(third.cached, false);
		assert.match(readFileSync(third.outFile, "utf8"), /第二版内容/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("缓存禁用时每次重转且不写缓存目录", async () => {
	const root = tempDir("dsh-md-cache-off-");
	const cacheDir = join(root, "cache");
	const outDir = join(root, "out");
	const src = join(root, "a.txt");
	try {
		writeFileSync(src, "x", "utf8");
		const opts = { outDir, cache: { enabled: false, dir: cacheDir } };
		const a = await convertFile(src, opts);
		const b = await convertFile(src, opts);
		assert.equal(a.cached, false);
		assert.equal(b.cached, false);
		assert.equal(existsSync(cacheDir), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("损坏或截断的缓存条目视为未命中", () => {
	const dir = tempDir("dsh-md-cache-bad-");
	try {
		const key = "0123456789abcdef.00000000";
		assert.equal(writeCache(dir, key, { md: "hello", chain: "text" }), true);
		assert.equal(readCache(dir, key).md, "hello");
		writeFileSync(join(dir, `${key}.md`), "hel", "utf8");
		assert.equal(readCache(dir, key), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cachePrune 按 mtime 从旧到新淘汰到容量上限", () => {
	const dir = tempDir("dsh-md-cache-prune-");
	try {
		const oldKey = "aaaaaaaaaaaaaaaa.00000000";
		const newKey = "bbbbbbbbbbbbbbbb.11111111";
		writeCache(dir, oldKey, { md: "A".repeat(200), chain: "text" });
		writeCache(dir, newKey, { md: "B".repeat(200), chain: "text" });
		const oldTime = new Date(Date.now() - 30 * 86_400_000);
		utimesSync(join(dir, `${oldKey}.md`), oldTime, oldTime);
		utimesSync(join(dir, `${oldKey}.json`), oldTime, oldTime);

		assert.equal(cacheStatus(dir).entries, 2);
		// 上限只容得下较新的一条:旧条目应被淘汰,新条目保留
		const newSize =
			statSync(join(dir, `${newKey}.md`)).size + statSync(join(dir, `${newKey}.json`)).size;
		const pruned = cachePrune(dir, { maxBytes: newSize + 1 });
		assert.ok(pruned.removed >= 1);
		assert.equal(existsSync(join(dir, `${oldKey}.md`)), false);
		assert.equal(existsSync(join(dir, `${newKey}.md`)), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("cacheClear 只删缓存文件,不动目录内其它文件", () => {
	const dir = tempDir("dsh-md-cache-clear-");
	try {
		const key = "cccccccccccccccc.22222222";
		writeCache(dir, key, { md: "x", chain: "text" });
		writeFileSync(join(dir, "user-output.md"), "keep me", "utf8");
		const cleared = cacheClear(dir);
		assert.ok(cleared.removed >= 2);
		assert.equal(existsSync(join(dir, `${key}.md`)), false);
		assert.equal(readFileSync(join(dir, "user-output.md"), "utf8"), "keep me");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveCacheDir:显式 > 环境变量 > 默认", () => {
	const prev = process.env.MD_CONVERT_CACHE_DIR;
	try {
		process.env.MD_CONVERT_CACHE_DIR = "C:/tmp/env-cache";
		assert.equal(resolveCacheDir("C:/tmp/explicit"), resolve("C:/tmp/explicit"));
		assert.equal(resolveCacheDir(""), resolve("C:/tmp/env-cache"));
		delete process.env.MD_CONVERT_CACHE_DIR;
		assert.ok(resolveCacheDir("").endsWith("md-convert-cache"));
	} finally {
		if (prev === undefined) delete process.env.MD_CONVERT_CACHE_DIR;
		else process.env.MD_CONVERT_CACHE_DIR = prev;
	}
});

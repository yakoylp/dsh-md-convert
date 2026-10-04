/**
 * markitdown 执行路径测试:子进程 worker 协议、错误映射、以及两种模式的端到端转换。
 *
 * 覆盖 0.5.7 的核心变化——宿主内必须走子进程加载 markitdown
 * (宿主插件依赖路由层会让 jsdom → whatwg-url → tr46 依赖链在加载时抛 TypeError)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertInProcess, convertViaWorker, convertWithMarkItDown } from "../lib/core/markitdown.js";
import { convertFile } from "../lib/core/convert.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "sample.docx");
const WORKER = join(here, "..", "lib", "core", "markitdown-worker.mjs");
/** 与 lib/core/markitdown.js 的默认选项一致(worker 参数化传入) */
const OPTIONS = { ocrLanguages: "chi_sim+eng", extractTables: true, extractImages: false };

/** 建一个不会被 sweepStale 认领的临时目录(前缀必须不同于 dsh-md-convert-)。 */
function tempDir() {
	return mkdtempSync(join(tmpdir(), "dsh-md-test-"));
}

test("markitdown-worker writes a JSON result file", () => {
	const dir = tempDir();
	const resultPath = join(dir, "result.json");
	try {
		const r = spawnSync(process.execPath, [WORKER, FIXTURE, resultPath, JSON.stringify(OPTIONS)], {
			encoding: "utf8",
		});
		assert.equal(r.status, 0, `worker 退出码应为 0,stderr: ${r.stderr ?? ""}`);
		const payload = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(payload.ok, true);
		assert.match(payload.markdown, /测试文档标题/, "应保留标题文本");
		assert.match(payload.markdown, /列表项一/, "应保留列表项");
		assert.match(payload.markdown, /\|\s*姓名\s*\|/, "应输出 markdown 表格");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("markitdown-worker reports failure as data, not a crash", () => {
	const dir = tempDir();
	const resultPath = join(dir, "result.json");
	try {
		const r = spawnSync(
			process.execPath,
			[WORKER, join(here, "fixtures", "no-such-file.docx"), resultPath, JSON.stringify(OPTIONS)],
			{ encoding: "utf8" },
		);
		assert.equal(r.status, 1, "转换失败应退出码 1");
		const payload = JSON.parse(readFileSync(resultPath, "utf8"));
		assert.equal(payload.ok, false);
		assert.ok(payload.error, "失败时应带 error 文本");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("convertViaWorker converts an Office fixture", async () => {
	const md = await convertViaWorker(FIXTURE, {});
	assert.match(md, /测试文档标题/);
	assert.match(md, /\|\s*姓名\s*\|/);
});

test("convertWithMarkItDown defaults to the worker path", async () => {
	const md = await convertWithMarkItDown(FIXTURE, {});
	assert.match(md, /测试文档标题/);
});

test("worker failures surface as E_MARKITDOWN with a readable message", async () => {
	await assert.rejects(
		() => convertWithMarkItDown(FIXTURE, { node: "dsh-md-convert-no-such-interpreter" }),
		(e) => e.code === "E_MARKITDOWN" && /无法启动 markitdown 子进程/.test(e.message),
	);
});

test("worker conversion failures surface as E_MARKITDOWN", async () => {
	await assert.rejects(
		() => convertWithMarkItDown(join(here, "fixtures", "no-such-file.docx"), {}),
		(e) => e.code === "E_MARKITDOWN",
	);
});

test("in-process mode still works outside a DSH host (fallback)", async () => {
	const md = await convertInProcess(FIXTURE);
	assert.match(md, /测试文档标题/);
});

test("convertFile converts through the worker by default", async () => {
	const dir = tempDir();
	try {
		const r = await convertFile(FIXTURE, { outDir: dir });
		assert.equal(r.ok, true, r.error);
		assert.equal(r.chain, "markitdown");
		assert.match(r.md, /测试文档标题/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

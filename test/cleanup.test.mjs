import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStale } from "../lib/core/cleanup.js";

test("sweepStale removes only plugin-owned leftover dirs", () => {
	const base = tmpdir();
	const oldFormat = mkdtempSync(join(base, "dsh-md-convert-")); // 旧版 mkdtemp 格式(无 pid)
	const userDir = join(base, "dsh-md-convert-my-stuff"); // 用户自建、共用前缀
	const deadPidDir = join(base, "dsh-md-convert-99999999-leftover"); // pid 已死的残留
	mkdirSync(userDir, { recursive: true });
	mkdirSync(deadPidDir, { recursive: true });
	try {
		sweepStale();
		assert.equal(existsSync(oldFormat), false, "旧版 mkdtemp 残留应被清扫");
		assert.equal(existsSync(userDir), true, "共用前缀的用户目录必须保留");
		assert.equal(existsSync(deadPidDir), false, "pid 已死的残留应被清扫");
	} finally {
		for (const dir of [oldFormat, userDir, deadPidDir]) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

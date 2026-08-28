/**
 * legacy.js 单元测试:auto 平台分流 + LibreOffice 后端(mock soffice)。
 * 运行: node --test test/legacy.test.mjs
 *
 * mock 策略:
 *   - Windows:用 PowerShell Add-Type 现场编译一个假 soffice.exe(Node 的
 *     spawnSync 只认 .exe/.com,不认 .cmd/.bat);编译不可用时跳过成功用例。
 *   - POSIX:写一个可执行 shell 脚本 soffice 并放入 PATH。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { convertLegacy, autoBackends } from "../lib/core/legacy.js";

const PATH_SEP = process.platform === "win32" ? ";" : ":";

/** .NET Framework C# 编译器(Windows 自带,用于现场编译假 soffice.exe) */
const CSC_CANDIDATES = [
	"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
	"C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

const FAKE_CS = `
using System;
using System.IO;
public class FakeSoffice {
  public static void Main(string[] args) {
    if (args.Length > 0 && args[0] == "--version") {
      Console.WriteLine("LibreOffice 24.2.0.2");
      return;
    }
    // args: --headless --norestore --convert-to <ext> --outdir <dir> <src>
    string ext = args.Length > 3 ? args[3] : "docx";
    string outdir = args.Length > 5 ? args[5] : ".";
    string src = args.Length > 6 ? args[6] : "";
    string stem = Path.GetFileNameWithoutExtension(src);
    File.WriteAllText(Path.Combine(outdir, stem + "." + ext), "fake convert: " + src);
  }
}
`;

/**
 * 在临时目录放一个假 soffice(PATH 打桩用)。
 * @returns {string|null} mock 目录;无法构建时(如 Windows 无编译环境)返回 null
 */
function makeFakeSoffice() {
	const dir = mkdtempSync(join(tmpdir(), "dsh-mock-soffice-"));
	try {
		if (process.platform === "win32") {
			// 用 .NET Framework csc.exe 编译假 soffice.exe(Node 的 spawnSync
			// 只认 .exe/.com,不认 .cmd/.bat)
			const csc = CSC_CANDIDATES.find((p) => existsSync(p));
			if (!csc) return null;
			const csPath = join(dir, "FakeSoffice.cs");
			writeFileSync(csPath, FAKE_CS, "utf8");
			const exePath = join(dir, "soffice.exe");
			execFileSync(csc, ["/nologo", `/out:${exePath}`, "/target:exe", csPath], {
				timeout: 60_000,
			});
			if (!existsSync(exePath)) return null;
		} else {
			// POSIX:可执行 shell 脚本
			writeFileSync(
				join(dir, "soffice"),
				`#!/bin/sh\n` +
					`if [ "$1" = "--version" ]; then\n` +
					`  echo "LibreOffice 24.2.0.2"\n` +
					`  exit 0\n` +
					`fi\n` +
					`# args: --headless --norestore --convert-to <ext> --outdir <dir> <src>\n` +
					`ext="$4"; outdir="$6"; src="$7"\n` +
					`base=$(basename "$src"); stem="\${base%.*}"\n` +
					`echo "fake convert: $src" > "$outdir/$stem.$ext"\n` +
					`exit 0\n`,
				"utf8",
			);
			try {
				chmodSync(join(dir, "soffice"), 0o755);
			} catch { /* 忽略 */ }
		}
		return dir;
	} catch {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
		return null;
	}
}

function withPath(extraDir, fn) {
	const prev = process.env.PATH;
	process.env.PATH = extraDir + PATH_SEP + (prev ?? "");
	try {
		return fn();
	} finally {
		process.env.PATH = prev;
	}
}

function makeSrcDoc(dir, name = "sample.doc") {
	const p = join(dir, name);
	writeFileSync(p, "fake legacy binary content", "utf8");
	return p;
}

test("autoBackends 平台分流", () => {
	assert.deepEqual(autoBackends("win32"), ["wps", "office"]);
	assert.deepEqual(autoBackends("linux"), ["libreoffice"]);
	assert.deepEqual(autoBackends("darwin"), ["libreoffice"]);
	assert.deepEqual(autoBackends(), autoBackends(process.platform));
});

test("convertLegacy(libreoffice) 成功:调用 soffice 并定位输出文件", (t) => {
	const fake = makeFakeSoffice();
	if (!fake) {
		t.skip("无法构建假 soffice(需要 PowerShell Add-Type / POSIX shell)");
		return;
	}
	const srcDir = mkdtempSync(join(tmpdir(), "dsh-mock-src-"));
	const outDir = mkdtempSync(join(tmpdir(), "dsh-mock-out-"));
	try {
		const src = makeSrcDoc(srcDir);
		const r = withPath(fake, () => convertLegacy(src, outDir, { backend: "libreoffice" }));
		assert.equal(r.ok, true, `应成功,实际错误: ${r.error ?? ""}`);
		assert.equal(r.backend, "libreoffice");
		const expected = join(outDir, "sample.docx");
		assert.equal(r.out, expected);
		assert.equal(existsSync(expected), true);
	} finally {
		rmSync(fake, { recursive: true, force: true });
		rmSync(srcDir, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	}
});

test("convertLegacy(libreoffice) 无 soffice 时返回明确错误", () => {
	const emptyDir = mkdtempSync(join(tmpdir(), "dsh-mock-empty-"));
	const srcDir = mkdtempSync(join(tmpdir(), "dsh-mock-src2-"));
	const outDir = mkdtempSync(join(tmpdir(), "dsh-mock-out2-"));
	try {
		const src = makeSrcDoc(srcDir, "sample.xls");
		const r = withPath(emptyDir, () => convertLegacy(src, outDir, { backend: "libreoffice" }));
		assert.equal(r.ok, false);
		assert.match(r.error, /libreoffice/i);
	} finally {
		rmSync(emptyDir, { recursive: true, force: true });
		rmSync(srcDir, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	}
});

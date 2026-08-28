/**
 * 冒烟测试:转换 test/fixtures 下全部样例文件,每个源文件输出独立命名的
 * <源名>.<扩展名>.md(避免同名 sample.* 互相覆盖)。
 *
 * 用法:
 *   node test/run-smoke.mjs                # 7 个非扫描样例
 *   node test/run-smoke.mjs --all          # 额外包含 scanned.pdf(走 PP-StructureV3 OCR)
 *   node test/run-smoke.mjs --force-ocr    # 全部 PDF 强制走 OCR
 *   node test/run-smoke.mjs --reference    # 另将完整参考集写入 fixtures/final-out/ 并提交
 */
import { mkdirSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { convertFile } from "../lib/core/convert.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const outDir = join(fixtures, "out");
const refDir = join(fixtures, "final-out");
mkdirSync(outDir, { recursive: true });

const forceOcr = process.argv.includes("--force-ocr");
const withAll = process.argv.includes("--all");
const asReference = process.argv.includes("--reference");

const files = [
	"sample.docx",
	"sample.xlsx",
	"sample.pptx",
	"sample.pdf",
	"sample.doc",
	"sample.xls",
	"sample.ppt",
].map((f) => join(fixtures, f));
if (withAll) files.push(join(fixtures, "scanned.pdf"));

console.log(
	`转换 ${files.length} 个文件 → ${outDir}${forceOcr ? " (强制 OCR)" : ""}${asReference ? " (同时生成 final-out 参考集)" : ""}\n`,
);

// 每个文件使用独立临时输出目录,再复制为 <源名>.<扩展名>.md,避免同名覆盖
const tmpRoot = mkdtempSync(join(tmpdir(), "dsh-smoke-"));
let failed = 0;
try {
	for (const [i, f] of files.entries()) {
		const perFileDir = join(tmpRoot, `f${i}`);
		mkdirSync(perFileDir, { recursive: true });
		const r = await convertFile(f, {
			outDir: perFileDir,
			forceOcr,
			legacy: { backend: "auto" },
		});
		if (r.ok) {
			const target = join(outDir, `${basename(f)}.md`);
			copyFileSync(r.outFile, target);
			console.log(`[${i + 1}] ✓ ${basename(f)}  (${r.chain})`);
			console.log(`       → ${target}  (${r.md?.length ?? 0} chars)`);
			for (const w of r.warnings ?? []) console.log(`       ⚠ ${w}`);
			if (asReference) {
				mkdirSync(refDir, { recursive: true });
				const refTarget = join(refDir, `${basename(f)}.md`);
				copyFileSync(r.outFile, refTarget);
				console.log(`       ★ 参考集 → ${refTarget}`);
			}
		} else {
			failed++;
			console.log(`[${i + 1}] ✗ ${basename(f)}  ${r.error}`);
		}
	}
} finally {
	rmSync(tmpRoot, { recursive: true, force: true });
}
console.log(`\n${failed === 0 ? "全部成功" : `${failed} 个失败`}`);
process.exit(failed ? 1 : 0);

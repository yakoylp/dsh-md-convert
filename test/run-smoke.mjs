/**
 * 冒烟测试:转换 test/fixtures 下全部样例文件到 test/fixtures/out/。
 * 用法: node test/run-smoke.mjs [--force-ocr]
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { convertMany } from "../lib/core/convert.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const outDir = join(fixtures, "out");
mkdirSync(outDir, { recursive: true });

const forceOcr = process.argv.includes("--force-ocr");

const files = [
	"sample.docx",
	"sample.xlsx",
	"sample.pptx",
	"sample.pdf",
	"sample.doc",
	"sample.xls",
	"sample.ppt",
].map((f) => join(fixtures, f));

console.log(`转换 ${files.length} 个文件 → ${outDir}${forceOcr ? " (强制 OCR)" : ""}\n`);

const results = await convertMany(files, {
	outDir,
	forceOcr,
	legacy: { backend: "auto" },
});

let failed = 0;
for (const [i, r] of results.entries()) {
	if (r.ok) {
		console.log(`[${i + 1}] ✓ ${files[i].split(/[\\/]/).pop()}  (${r.chain})`);
		console.log(`       → ${r.outFile}  (${r.md?.length ?? 0} chars)`);
		for (const w of r.warnings ?? []) console.log(`       ⚠ ${w}`);
	} else {
		failed++;
		console.log(`[${i + 1}] ✗ ${files[i].split(/[\\/]/).pop()}  ${r.error}`);
	}
}
console.log(`\n${failed === 0 ? "全部成功" : `${failed} 个失败`}`);
process.exit(failed ? 1 : 0);

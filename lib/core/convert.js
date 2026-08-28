/**
 * dsh-md-convert — 核心转换流水线
 *
 * 单文件链路:
 *   modern  : markitdown 原生转换(docx/xlsx/pptx/pdf 文字层、html/csv/json/...)
 *   legacy  : WPS/Office COM 另存为现代格式 → markitdown
 *   scanned : PP-StructureV3(版面分析 + OCR)→ 按阅读顺序拼装结构化 Markdown
 *
 * 所有中间文件(另存结果等)放入 TempScope 临时目录,
 * 转换结束(成功或失败)后统一清理。OCR 无中间文件(Python 侧内存完成)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { classify } from "./detect.js";
import { convertLegacy } from "./legacy.js";
import { ocrPpstructure, ensureOcrDeps } from "./ocr.js";
import { TempScope, sweepStale } from "./cleanup.js";
import { err, codeOf, ERROR_CODES } from "./errors.js";

/** PDF 文字层判定:markitdown 结果低于该字符数视为扫描件 */
const PDF_MIN_TEXT = 20;

/** 默认配置 */
const DEFAULT_OPTS = {
	outDir: null,          // 输出目录(必填)
	forceOcr: false,       // 强制 PDF 走 OCR
	ocrScale: 2,           // PDF 渲染倍率
	ocr: {},               // OCR 配置(python / scale)
	autoInstallDeps: true, // 缺 OCR 依赖时自动 pip 安装
	legacy: { backend: "auto" },
	title: true,           // md 开头加源文件名标题
	meta: true,            // 末尾加转换溯源注释
	overwrite: true,       // 覆盖同名输出
	keepTemp: false,       // 调试:保留临时文件
	onLog: null,           // (msg: string) => void 进度回调(依赖安装等)
};

function normalizeOpts(opts = {}) {
	const o = { ...DEFAULT_OPTS, ...opts };
	o.legacy = { ...DEFAULT_OPTS.legacy, ...(opts.legacy ?? {}) };
	if (!o.outDir) throw new Error("outDir is required");
	return o;
}

function log(o, msg) {
	if (typeof o.onLog === "function") o.onLog(msg);
}

/** 目标输出路径:同目录或指定 outDir,同名 .md */
function outputPathFor(input, opts) {
	const base = basename(input).replace(/\.[^.]+$/, "") + ".md";
	return join(opts.outDir, base);
}

function metaComment(input, chain) {
	const when = new Date().toISOString();
	return `\n\n<!-- 源文件: ${basename(input)} | 链路: ${chain} | dsh-md-convert | ${when} -->\n`;
}

/** 通过 markitdown-node 转换(CJS 入口;其 ESM 入口内部 require 在纯 ESM 下不可用) */
async function viaMarkItDown(inputPath) {
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const { MarkItDown } = require("markitdown-node");
	const converter = new MarkItDown({
		defaultOptions: { ocrLanguages: "chi_sim+eng", extractTables: true, extractImages: false },
	});
	const result = await converter.convert(inputPath);
	if (result?.status !== "success") {
		throw err(ERROR_CODES.E_MARKITDOWN, `markitdown 转换失败:${(result?.errors ?? []).join("; ") || "未知原因"}`);
	}
	return result.markdown_content ?? "";
}

/** 文本类文件直接读取 */
function viaPlainText(inputPath) {
	return readFileSync(inputPath, "utf8");
}

const PLAIN_EXT = new Set(["md", "markdown", "txt"]);

/** PP-StructureV3 块 → Markdown(按版面顺序拼装) */
function blockToMd(label, content) {
	content = String(content ?? "").trim();
	switch (label) {
		case "paragraph_title":
		case "title":
			return content ? `## ${content}` : "";
		case "table":
			return content; // Python 侧已把表格 HTML 转为管道表格
		case "formula":
			return content ? `$$ ${content} $$` : "";
		case "seal":
		case "stamp":
			return `<!-- ${label}:${content ? ` ${content}` : " 印章"} -->`;
		case "header":
		case "footer":
			return content ? `<!-- ${label}: ${content} -->` : "";
		case "image":
		case "figure":
		case "figure_title":
		case "figure_caption":
			return `![${label}]()`;
		default:
			return content;
	}
}

/** 扫描件:确保 OCR 依赖 → 调用 PP-StructureV3(整份 PDF 一次调用) */
async function viaOcr(inputPath, opts) {
	// 1. 确保依赖(缺则按 autoInstallDeps 自动安装)
	const dep = await ensureOcrDeps({
		...opts.ocr,
		autoInstall: opts.autoInstallDeps !== false,
		onLog: (m) => log(opts, m),
	});
	if (!dep.ok) {
		return { ok: false, code: ERROR_CODES.E_OCR_DEPS, error: dep.error };
	}

	// 2. 执行 PP-StructureV3
	const result = await ocrPpstructure(inputPath, { ...opts.ocr, scale: opts.ocrScale });
	if (!result.ok) {
		return { ok: false, code: ERROR_CODES.E_OCR_RUN, error: result.error };
	}
	const warnings = [];
	const parts = [];
	for (const page of result.pages ?? []) {
		if (!page.blocks || page.blocks.length === 0) {
			warnings.push(`第 ${page.index ?? "?"} 页未识别出内容`);
			continue;
		}
		parts.push(`<!-- page ${page.index} -->\n\n` + page.blocks.map((b) => blockToMd(b.label, b.content)).filter(Boolean).join("\n\n"));
	}
	if (result.warning) warnings.push(result.warning);
	const body = parts.join("\n\n");
	if (!body.trim()) {
		return { ok: false, code: ERROR_CODES.E_OCR_EMPTY, error: "PP-StructureV3 未识别出任何内容(扫描页可能过暗/方向异常)" };
	}
	return { ok: true, md: body, warnings };
}

/**
 * 转换单个文件为 Markdown。
 * @param {string} inputPath
 * @param {object} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   file?: string,          // 源文件绝对路径(定位批量失败用)
 *   code?: string,          // 错误码(仅失败时),见 lib/core/errors.js
 *   md?: string, outFile?: string, chain?: string, warnings?: string[],
 *   error?: string
 * }>}
 */
export async function convertFile(inputPath, opts = {}) {
	sweepStale(); // 顺带清理历史崩溃残留
	inputPath = resolve(inputPath); // COM 后端等需要绝对路径
	const o = normalizeOpts(opts);
	const scope = new TempScope();
	try {
		if (!existsSync(inputPath)) {
			return { ok: false, file: inputPath, code: ERROR_CODES.E_FILE_NOT_FOUND, error: `文件不存在:${inputPath}` };
		}
		const info = { hasTextLayer: null };
		const cls = classify(inputPath, info);
		let md = "";
		let chain = "";
		let warnings = [];

		if (cls.kind === "unsupported") {
			return { ok: false, file: inputPath, code: ERROR_CODES.E_UNSUPPORTED_FORMAT, error: `不支持的格式:${cls.ext || "(无扩展名)"}` };
		}

		if (cls.kind === "legacy") {
			// 老格式:先另存为现代格式
			const tmpDir = scope.dir("legacy");
			const conv = convertLegacy(inputPath, tmpDir, { backend: o.legacy.backend });
			if (!conv.ok) {
				return { ok: false, file: inputPath, code: ERROR_CODES.E_LEGACY_CONVERT, error: conv.error };
			}
			const converted = conv.out;
			md = await viaMarkItDown(converted);
			chain = `legacy(${conv.backend}) → markitdown`;
			// converted 在临时目录,scope.dispose() 时清理
		} else if (cls.kind === "scanned" || (cls.ext === "pdf" && o.forceOcr)) {
			const r = await viaOcr(inputPath, o);
			if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error };
			md = r.md;
			chain = "PP-StructureV3";
			warnings = r.warnings;
		} else if (PLAIN_EXT.has(cls.ext)) {
			md = viaPlainText(inputPath);
			chain = "text";
		} else {
			// modern(markitdown 原生)
			if (cls.ext === "pdf") {
				// 先尝试文字层;空结果回退 PP-StructureV3
				try {
					md = await viaMarkItDown(inputPath);
				} catch (e) {
					md = "";
				}
				if (!md || md.trim().length < PDF_MIN_TEXT) {
					const r = await viaOcr(inputPath, o);
					if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error };
					md = r.md;
					chain = "markitdown(空) → PP-StructureV3";
					warnings = r.warnings;
				} else {
					chain = "markitdown(pdf 文字层)";
				}
			} else {
				md = await viaMarkItDown(inputPath);
				chain = "markitdown";
			}
		}

		// 组装最终 Markdown
		const title = o.title ? `# ${basename(inputPath).replace(/\.[^.]+$/, "")}\n\n` : "";
		const meta = o.meta ? metaComment(inputPath, chain) : "";
		const finalMd = `${title}${md.trim()}\n${meta}`;

		const outFile = outputPathFor(inputPath, o);
		try {
			if (o.overwrite || !fileExists(outFile)) {
				mkdirSync(o.outDir, { recursive: true });
				writeFileSync(outFile, finalMd, "utf8");
			}
		} catch (e) {
			return { ok: false, file: inputPath, code: ERROR_CODES.E_OUTPUT, error: `无法写入输出文件 ${outFile}:${e.message}` };
		}
		return { ok: true, file: inputPath, md: finalMd, outFile, chain, warnings };
	} catch (e) {
		return { ok: false, file: inputPath, code: codeOf(e), error: e?.message ?? String(e) };
	} finally {
		if (!o.keepTemp) scope.dispose();
	}
}

function fileExists(p) {
	try { return existsSync(p); } catch { return false; }
}

/**
 * 批量转换。
 * @param {string[]} inputs
 * @param {object} [opts]
 * @returns {Promise<Array>} 与 convertFile 同构的结果数组
 */
export async function convertMany(inputs, opts = {}) {
	const results = [];
	for (const f of inputs) {
		results.push(await convertFile(f, opts));
	}
	return results;
}


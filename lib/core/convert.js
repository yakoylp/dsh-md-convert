/**
 * dsh-md-convert — 核心转换流水线
 *
 * 单文件链路:
 *   modern  : markitdown 原生转换(docx/xlsx/pptx/pdf 文字层、html/csv/json/...)
 *   legacy  : WPS/Office COM 另存为现代格式 → markitdown
 *   scanned : 路由 OCR(PP-DocLayout-L 版面 + RapidOCR/SLANet/FormulaNet 区域路由)
 *
 * 所有中间文件(另存结果等)放入 TempScope 临时目录,
 * 转换结束(成功或失败)后统一清理。OCR 无中间文件(Python 侧内存完成)。
 *
 * markitdown 默认在**子进程**中执行(见 core/markitdown.js):宿主进程内的插件依赖
 * 路由层会让 markitdown 的依赖链(jsdom → whatwg-url → tr46)在加载时失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { classify } from "./detect.js";
import { convertLegacy } from "./legacy.js";
import { ocrPpstructure, ensureOcrDeps } from "./ocr.js";
import { ocrModelCacheStatus } from "./deps.js";
import { TempScope, sweepStale } from "./cleanup.js";
import { codeOf, ERROR_CODES } from "./errors.js";
import { convertWithMarkItDown } from "./markitdown.js";

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
	markitdown: {},        // markitdown 执行方式(mode / node / timeoutMs,见 core/markitdown.js)
	title: true,           // md 开头加源文件名标题
	meta: true,            // 末尾加转换溯源注释
	overwrite: true,       // 覆盖同名输出
	keepTemp: false,       // 调试:保留临时文件
	onLog: null,           // (msg: string) => void 进度回调(依赖安装等)
};

function normalizeOpts(opts = {}) {
	const o = { ...DEFAULT_OPTS, ...opts };
	o.legacy = { ...DEFAULT_OPTS.legacy, ...(opts.legacy ?? {}) };
	o.markitdown = { ...DEFAULT_OPTS.markitdown, ...(opts.markitdown ?? {}) };
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

/** 通过 markitdown 转换(默认子进程执行;实现与原因见 core/markitdown.js) */
function viaMarkItDown(inputPath, cfg) {
	return convertWithMarkItDown(inputPath, cfg);
}

/** 文本类文件直接读取 */
function viaPlainText(inputPath) {
	return readFileSync(inputPath, "utf8");
}

const PLAIN_EXT = new Set(["md", "markdown", "txt"]);

/** 扫描件:确保 OCR 依赖 → 调用路由 OCR 流水线(整份 PDF 一次调用,返回组装好的 md) */
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

	// 2. 模型缓存检查:路由 OCR 以离线模式运行,不自动联网下载;缺失时明确指引,
	//    而不是让它带着晦涩的 paddle 报错失败(下载只在 CLI 的 `dsh-md-convert deps` 阶段进行)。
	const models = ocrModelCacheStatus(dep.python);
	if (!models.ok) {
		return {
			ok: false,
			code: ERROR_CODES.E_OCR_DEPS,
			error:
				`OCR 模型未缓存(缺 ${models.missing.length} 个)。` +
				`请先联网执行一次 \`dsh-md-convert deps\` 预下载模型到本地,之后即可完全离线运行。`,
		};
	}

	// 3. 执行路由 OCR(PP-DocLayout-L 版面 + RapidOCR/SLANet/FormulaNet 区域路由)
	const result = await ocrPpstructure(inputPath, { ...opts.ocr, scale: opts.ocrScale });
	if (!result.ok) {
		return { ok: false, code: ERROR_CODES.E_OCR_RUN, error: result.error };
	}
	const body = (result.md ?? "").trim();
	if (!body) {
		return { ok: false, code: ERROR_CODES.E_OCR_EMPTY, error: "未识别出任何内容(扫描页可能过暗/方向异常)" };
	}
	return { ok: true, md: body, warnings: result.warnings ?? [] };
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
			md = await viaMarkItDown(converted, o.markitdown);
			chain = `legacy(${conv.backend}) → markitdown`;
			// converted 在临时目录,scope.dispose() 时清理
		} else if (cls.kind === "scanned" || (cls.ext === "pdf" && o.forceOcr)) {
			const r = await viaOcr(inputPath, o);
			if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error };
			md = r.md;
			chain = "路由OCR";
			warnings = r.warnings;
		} else if (PLAIN_EXT.has(cls.ext)) {
			md = viaPlainText(inputPath);
			chain = "text";
		} else {
			// modern(markitdown 原生)
			if (cls.ext === "pdf") {
				// 先尝试文字层;空结果回退路由 OCR
				try {
					md = await viaMarkItDown(inputPath, o.markitdown);
				} catch (e) {
					md = "";
				}
				if (!md || md.trim().length < PDF_MIN_TEXT) {
					const r = await viaOcr(inputPath, o);
					if (!r.ok) return { ok: false, file: inputPath, code: r.code, error: r.error };
					md = r.md;
					chain = "markitdown(空) → 路由OCR";
					warnings = r.warnings;
				} else {
					chain = "markitdown(pdf 文字层)";
				}
			} else {
				md = await viaMarkItDown(inputPath, o.markitdown);
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


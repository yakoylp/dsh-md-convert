/**
 * dsh-md-convert — OCR 模块(唯一引擎:PP-StructureV3)
 *
 * 扫描件识别固定使用百度 PP-StructureV3(paddlepaddle + paddleocr,CPU 可跑):
 *   渲染 PDF → 版面分析(标题/正文/表格/公式/印章)→ 按阅读顺序输出结构化块。
 *
 * 本模块通过命令行调用打包的 Python 脚本 lib/py/ppstructure_md.py,
 * 一次调用处理整个 PDF,返回 JSON 块列表,由 convert.js 拼装 Markdown。
 *
 * 依赖检测/自动安装见 lib/core/deps.js(ensureOcrDeps)。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectPython } from "./deps.js";
export { ensureOcrDeps, findMissingModules, installModules, PY_MODULES } from "./deps.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PPSTRUCTURE_SCRIPT = join(here, "..", "py", "ppstructure_md.py");

/** OCR 配置结构(极简) */
const DEFAULT_OCR_CONFIG = {
	python: "",   // 留空自动探测 python / python3 / py
	scale: 2,     // PDF 渲染倍率
};

export function normalizeOcrConfig(cfg = {}) {
	// 显式兜底:undefined 不得覆盖默认值
	return {
		python: cfg.python ?? DEFAULT_OCR_CONFIG.python,
		scale: cfg.scale ?? DEFAULT_OCR_CONFIG.scale,
	};
}

/**
 * 对 PDF(或图片)执行 PP-StructureV3 识别。
 * @param {string} inputPath PDF 或图片路径
 * @param {object} [cfg] { python, scale }
 * @returns {Promise<{ ok: boolean, pages?: Array<{index:number, blocks:Array<{label:string,content:string,order_index:number}>}>, warning?: string, error?: string }>}
 */
export async function ocrPpstructure(inputPath, cfg = {}) {
	const c = normalizeOcrConfig(cfg);
	const python = c.python || detectPython();
	if (!python) {
		return { ok: false, error: "未找到 Python。请安装 Python 后重试" };
	}
	const r = spawnSync(python, [PPSTRUCTURE_SCRIPT, inputPath, "--scale", String(c.scale)], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
		timeout: 1_200_000, // PP-StructureV3 首跑含模型加载,给足时间
		windowsHide: true,
	});
	if (r.status !== 0) {
		const tail = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-6).join("\n");
		return { ok: false, error: `PP-StructureV3 执行失败:${tail}` };
	}
	try {
		const parsed = JSON.parse(r.stdout.trim());
		if (!parsed.ok) return { ok: false, error: parsed.error || "PP-StructureV3 返回失败" };
		return {
			ok: true,
			pages: parsed.pages ?? [],
			warning: parsed.warning,
		};
	} catch (e) {
		return { ok: false, error: `无法解析 PP-StructureV3 输出:${e.message}` };
	}
}


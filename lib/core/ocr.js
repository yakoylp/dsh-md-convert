/**
 * dsh-md-convert — OCR 模块(模块化路由引擎)
 *
 * 扫描件识别走「路由流水线」lib/py/routing_ocr.py:
 *   PP-DocLayout-L 版面 → 按区域路由(RapidOCR 文字 / SLANet+RT-DETR 表格 /
 *   FormulaNet-S 公式 / 印章注释),全部本地 CPU、轻量模型优先、性价比优先。
 *
 * 本模块调用 Python 脚本,一次调用处理整个 PDF,stdout 返回 JSON:
 *   { ok, md: 完整 Markdown 文本, warnings?: [] }
 *
 * 依赖检测/自动安装见 lib/core/deps.js(ensureOcrDeps)。
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runAsync } from "./spawn.js";
import { detectPython } from "./deps.js";
export { ensureOcrDeps, findMissingModules, installModules, PY_MODULES } from "./deps.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ROUTING_SCRIPT = join(here, "..", "py", "routing_ocr.py");

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
 * 对扫描件 PDF 执行路由 OCR(整份 PDF 一次调用)。
 * @param {string} inputPath PDF 路径
 * @param {object} [cfg] { python, scale }
 * @returns {Promise<{ ok: boolean, md?: string, warnings?: string[], error?: string }>}
 */
export async function ocrPpstructure(inputPath, cfg = {}) {
	const c = normalizeOcrConfig(cfg);
	const python = c.python || detectPython();
	if (!python) {
		return { ok: false, error: "未找到 Python。请安装 Python 后重试" };
	}
	const r = await runAsync(python, [ROUTING_SCRIPT, inputPath, "--scale", String(c.scale)], {
		timeout: 7_200_000, // 多页扫描件整 PDF 一次调用: 单页数秒~十几秒, 长文档给足 120 分钟
		maxBuffer: 512 * 1024 * 1024,
	});
	if (r.status !== 0) {
		if (r.error) return { ok: false, error: `路由 OCR 执行失败:${r.error}` };
		const tail = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-6).join("\n");
		return { ok: false, error: `路由 OCR 执行失败:${tail || "(无输出)"}` };
	}
	try {
		const parsed = JSON.parse(r.stdout.trim());
		if (!parsed.ok) return { ok: false, error: parsed.error || "路由 OCR 返回失败" };
		return {
			ok: true,
			md: parsed.md ?? "",
			warnings: parsed.warnings ?? [],
		};
	} catch (e) {
		return { ok: false, error: `无法解析路由 OCR 输出:${e.message}` };
	}
}

/**
 * dsh-md-convert — OCR 依赖检测与自动安装
 *
 * 扫描件 OCR 依赖(模块化路由引擎):Python + paddlepaddle + paddleocr + paddlex[ocr]
 * + pypdfium2 + rapidocr + onnxruntime,以及路由引擎各模型
 * (本地缓存 ~/.paddlex/official_models/,运行时完全离线)。
 *
 * 策略:
 *   - 检测:用 importlib.util.find_spec 快速探测(不实际 import,避免加载 paddle);
 *   - 已装 → 直接使用;缺失 → 按 autoInstall 决定自动 pip 安装或给出指引;
 *   - 安装幂等:只装缺失的包,已有跳过。
 *   - 模型:ensureOcrModels 联网预下载(安装期);运行时 routing_ocr.py 设了
 *     PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=true,模型缓存齐全即零网络。
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAsync } from "./spawn.js";

/** 模块名 → pip 包名 */
export const PY_MODULES = {
	paddle: "paddlepaddle",
	paddleocr: "paddleocr",
	paddlex: "paddlex[ocr]",
	pypdfium2: "pypdfium2",
	rapidocr: "rapidocr",
	onnxruntime: "onnxruntime",
};

/** 按平台排序的 python 解释器候选(win32 有 py 启动器;Linux/macOS 惯例 python3) */
function pythonCandidates() {
	return process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
}

/** 探测可用的 python 解释器 */
export function detectPython(preferred = "") {
	if (preferred) {
		if (isPython(preferred)) return preferred;
	}
	for (const py of pythonCandidates()) {
		if (isPython(py)) return py;
	}
	return null;
}

function isPython(py) {
	const r = spawnSync(py, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true });
	return r.status === 0 && /Python/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/**
 * 检测指定 python 中缺失的 OCR 模块。
 * @param {string} python
 * @returns {{ missing: string[] }} missing 为 PY_MODULES 的键列表
 */
export function findMissingModules(python) {
	const probe = `
import importlib.util, sys
mods = [${Object.keys(PY_MODULES).map((m) => `"${m}"`).join(", ")}]
missing = [m for m in mods if importlib.util.find_spec(m) is None]
print(",".join(missing))
`;
	const r = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 60_000, windowsHide: true });
	const out = (r.stdout ?? "").trim();
	if (r.status !== 0) {
		// 无法探测:保守返回全部缺失
		return { missing: Object.keys(PY_MODULES) };
	}
	const missing = out ? out.split(",").filter(Boolean) : [];
	return { missing };
}

/**
 * 安装缺失的 OCR 依赖(pip)。
 * PEP 668(Externally Managed Environment,常见于 Debian/Ubuntu 系统 Python)会拒绝
 * 全局 pip 安装,检测到该错误时自动追加 `--break-system-packages` 重试一次。
 * @param {string} python
 * @param {string[]} missing PY_MODULES 的键
 * @param {(msg: string) => void} [onLog]
 * @returns {{ ok: boolean, installed: string[], error?: string }}
 */
export async function installModules(python, missing, onLog) {
	const installed = [];
	for (const key of missing) {
		const pkg = PY_MODULES[key];
		const msg = `正在安装 ${pkg}(${key})...`;
		if (typeof onLog === "function") onLog(msg);
		let r = await runAsync(python, ["-m", "pip", "install", "--disable-pip-version-check", pkg], {
			timeout: 1_800_000, // 大包(paddlepaddle)下载可能较久
		});
		const combined = `${r.stderr ?? ""}${r.stdout ?? ""}`;
		if (r.status !== 0 && /externally-managed-environment/i.test(combined)) {
			// PEP 668:系统 Python 受管理,显式放行后重试一次
			if (typeof onLog === "function") onLog(`检测到 PEP 668(系统 Python 受管),追加 --break-system-packages 重试...`);
			r = await runAsync(
				python,
				["-m", "pip", "install", "--disable-pip-version-check", "--break-system-packages", pkg],
				{ timeout: 1_800_000 },
			);
		}
		if (r.status !== 0) {
			const detail = r.error
				? r.error
				: `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-5).join("\n");
			return { ok: false, installed, error: `pip install ${pkg} 失败:${detail}` };
		}
		installed.push(pkg);
	}
	return { ok: true, installed };
}

/**
 * 检查并(可选)安装 OCR 依赖。
 * @param {object} [opts]
 * @param {string} [opts.python] 指定解释器;空则自动探测
 * @param {boolean} [opts.autoInstall=true] 缺失时自动 pip 安装
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {Promise<{ ok: boolean, python?: string, installed?: string[], error?: string }>}
 */
export async function ensureOcrDeps(opts = {}) {
	const python = detectPython(opts.python);
	if (!python) {
		return {
			ok: false,
			error:
				process.platform === "win32"
					? "未找到 Python。请安装 Python(https://www.python.org/downloads/)后重试"
					: "未找到 Python。请安装后重试(Linux: apt install python3 python3-pip;macOS: brew install python)",
		};
	}
	const { missing } = findMissingModules(python);
	if (missing.length === 0) {
		return { ok: true, python, installed: [] };
	}
	if (opts.autoInstall === false) {
		return {
			ok: false,
			error: `Python 缺少 OCR 依赖(${missing.join(", ")})。请执行: python -m pip install ${missing.map((m) => PY_MODULES[m]).join(" ")}`,
		};
	}
	const r = await installModules(python, missing, opts.onLog);
	if (!r.ok) return { ok: false, python, error: r.error };
	return { ok: true, python, installed: r.installed };
}

/* ------------------------------------------------------------------ *
 * 路由 OCR 模型(安装期预下载 → 运行时离线)
 * ------------------------------------------------------------------ */

/** 路由引擎实际加载的模型目录名(与 lib/py/routing_ocr.py 一致) */
export const REQUIRED_MODELS = [
	"PP-DocLayout-L",                          // 版面分析(阈值 0.3)
	"PP-LCNet_x1_0_table_cls",                 // 表格有线/无线分类
	"SLANeXt_wired",                           // 有线表格结构
	"SLANet_plus",                             // 无线表格结构
	"RT-DETR-L_wired_table_cell_det",          // 有线表格单元格定位
	"RT-DETR-L_wireless_table_cell_det",       // 无线表格单元格定位
	"PP-FormulaNet_plus-S",                    // 公式识别(轻量)
];

/** 模型缓存目录:~/ 下 .paddlex/official_models(与 paddlex CACHE_DIR 一致) */
function modelCacheDir() {
	return join(homedir(), ".paddlex", "official_models");
}

/**
 * 检查本地模型缓存状态(不 import paddle,快速)。
 * @param {string} python
 * @returns {{ ok: boolean, missing: string[], cacheDir: string }}
 */
export function ocrModelCacheStatus(python) {
	const probe = `
import os
from pathlib import Path
cache = Path(os.path.expanduser("~")) / ".paddlex" / "official_models"
models = ${JSON.stringify(REQUIRED_MODELS)}
missing = [m for m in models if not (cache / m).is_dir()]
print(json_out := ",".join(missing) if missing else "ALL_CACHED")
`;
	const r = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 60_000, windowsHide: true });
	const out = (r.stdout ?? "").trim();
	if (r.status !== 0 || !out) {
		// 探测失败:保守视为全部缺失
		return { ok: false, missing: [...REQUIRED_MODELS], cacheDir: modelCacheDir() };
	}
	return {
		ok: out === "ALL_CACHED",
		missing: out === "ALL_CACHED" ? [] : out.split(",").filter(Boolean),
		cacheDir: modelCacheDir(),
	};
}

/**
 * 确保路由 OCR 模型就绪(缺失时联网下载到本地缓存)。
 * 注意:此步骤**不设置** PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK(允许下载);
 * 运行时(routing_ocr.py)才启用离线模式。
 * @param {string} python
 * @param {(msg: string) => void} [onLog]
 * @returns {{ ok: boolean, downloaded: string[], error?: string }}
 */
export async function ensureOcrModels(python, onLog) {
	const status = ocrModelCacheStatus(python);
	if (status.ok) {
		return { ok: true, downloaded: [] };
	}
	if (typeof onLog === "function") {
		onLog(`模型未就绪,开始联网下载(${status.missing.length} 个,首次约数百 MB,请保持网络通畅)...`);
	}
	// 直接构造路由引擎各子模型 → 触发缺失模型下载(不设离线开关)
	const snippet = `
import time
from paddleocr import (
    LayoutDetection, TableClassification,
    TableStructureRecognition, TableCellsDetection, FormulaRecognition,
)
t = time.time()
LayoutDetection(model_name="PP-DocLayout-L", threshold=0.3)
TableClassification(model_name="PP-LCNet_x1_0_table_cls")
TableStructureRecognition(model_name="SLANeXt_wired")
TableStructureRecognition(model_name="SLANet_plus")
TableCellsDetection(model_name="RT-DETR-L_wired_table_cell_det")
TableCellsDetection(model_name="RT-DETR-L_wireless_table_cell_det")
FormulaRecognition(model_name="PP-FormulaNet_plus-S")
print("MODELS_READY in %.0fs" % (time.time() - t))
`;
	const r = await runAsync(python, ["-c", snippet], {
		timeout: 1_800_000, // 大模型下载可能较久
	});
	const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	if (r.status !== 0 || !/MODELS_READY/.test(text)) {
		const tail = r.error ? r.error : text.split("\n").slice(-6).join("\n");
		return {
			ok: false,
			downloaded: [],
			error: `OCR 模型就绪失败(需要网络):${tail || "(无输出)"}`,
		};
	}
	const after = ocrModelCacheStatus(python);
	return { ok: true, downloaded: after.missing.length === 0 ? [...status.missing] : [] };
}

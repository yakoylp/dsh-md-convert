/**
 * dsh-md-convert — OCR 依赖检测与自动安装
 *
 * 扫描件 OCR 依赖:Python + paddlepaddle + paddleocr + paddlex[ocr] + pypdfium2,
 * 以及 PP-StructureV3 模型(本地缓存 ~/.paddlex/official_models/,运行时完全离线)。
 *
 * 策略:
 *   - 检测:用 importlib.util.find_spec 快速探测(不实际 import,避免加载 paddle);
 *   - 已装 → 直接使用;缺失 → 按 autoInstall 决定自动 pip 安装或给出指引;
 *   - 安装幂等:只装缺失的包,已有跳过。
 *   - 模型:ensureOcrModels 联网预下载(安装期);运行时 ppstructure_md.py 设了
 *     PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=true,模型缓存齐全即零网络。
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** 模块名 → pip 包名 */
export const PY_MODULES = {
	paddle: "paddlepaddle",
	paddleocr: "paddleocr",
	paddlex: "paddlex[ocr]",
	pypdfium2: "pypdfium2",
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
export function installModules(python, missing, onLog) {
	const installed = [];
	for (const key of missing) {
		const pkg = PY_MODULES[key];
		const msg = `正在安装 ${pkg}(${key})...`;
		if (typeof onLog === "function") onLog(msg);
		let r = spawnSync(python, ["-m", "pip", "install", "--disable-pip-version-check", pkg], {
			encoding: "utf8",
			timeout: 1_800_000, // 大包(paddlepaddle)下载可能较久
			windowsHide: true,
		});
		const combined = `${r.stderr ?? ""}${r.stdout ?? ""}`;
		if (r.status !== 0 && /externally-managed-environment/i.test(combined)) {
			// PEP 668:系统 Python 受管理,显式放行后重试一次
			if (typeof onLog === "function") onLog(`检测到 PEP 668(系统 Python 受管),追加 --break-system-packages 重试...`);
			r = spawnSync(
				python,
				["-m", "pip", "install", "--disable-pip-version-check", "--break-system-packages", pkg],
				{ encoding: "utf8", timeout: 1_800_000, windowsHide: true },
			);
		}
		if (r.status !== 0) {
			const tail = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim().split("\n").slice(-5).join("\n");
			return { ok: false, installed, error: `pip install ${pkg} 失败:${tail}` };
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
	const r = installModules(python, missing, opts.onLog);
	if (!r.ok) return { ok: false, python, error: r.error };
	return { ok: true, python, installed: r.installed };
}

/* ------------------------------------------------------------------ *
 * PP-StructureV3 模型(安装期预下载 → 运行时离线)
 * ------------------------------------------------------------------ */

/** 精简管线(与 lib/py/ppstructure_md.py 一致)实际加载的模型目录名 */
export const REQUIRED_MODELS = [
	"PP-DocBlockLayout",
	"PP-DocLayout_plus-L",
	"PP-OCRv5_server_det",
	"PP-OCRv5_server_rec",
	"PP-LCNet_x1_0_table_cls",
	"SLANeXt_wired",
	"SLANet_plus",
	"RT-DETR-L_wired_table_cell_det",
	"RT-DETR-L_wireless_table_cell_det",
];

/** 可选模块对应模型(启用时纳入预下载/检查;印章识别/图表识别为按需懒加载,仅列已知项) */
const FEATURE_MODELS = {
	formula: ["PP-FormulaNet_plus-L"],
	seal: ["PP-OCRv4_server_seal_det"],
	chart: [],
};

/**
 * 按启用的 OCR 特性计算所需模型清单(fast 模式用 mobile 检测/识别模型替换 server 版)。
 * @param {{formula?: boolean, seal?: boolean, chart?: boolean, fast?: boolean}} [features]
 */
export function modelsForFeatures(features = {}) {
	let list = [...REQUIRED_MODELS];
	if (features.fast) {
		list = list.map((m) =>
			m === "PP-OCRv5_server_det" ? "PP-OCRv5_mobile_det" : m === "PP-OCRv5_server_rec" ? "PP-OCRv5_mobile_rec" : m,
		);
	}
	if (features.formula) list.push(...(FEATURE_MODELS.formula ?? []));
	if (features.seal) list.push(...(FEATURE_MODELS.seal ?? []));
	if (features.chart) list.push(...(FEATURE_MODELS.chart ?? []));
	return list;
}

/** 是否启用了任意可选模块 */
function anyFeature(features) {
	return !!(features.formula || features.seal || features.chart || features.fast);
}

/** 模型缓存目录:~/ 下 .paddlex/official_models(与 paddlex CACHE_DIR 一致) */
function modelCacheDir() {
	return join(homedir(), ".paddlex", "official_models");
}

/**
 * 检查本地模型缓存状态(不 import paddle,快速)。
 * @param {string} python
 * @param {{formula?: boolean, seal?: boolean, chart?: boolean}} [features]
 * @returns {{ ok: boolean, missing: string[], cacheDir: string }}
 */
export function ocrModelCacheStatus(python, features = {}) {
	const models = modelsForFeatures(features);
	const probe = `
import os
from pathlib import Path
cache = Path(os.path.expanduser("~")) / ".paddlex" / "official_models"
models = ${JSON.stringify(models)}
missing = [m for m in models if not (cache / m).is_dir()]
print(json_out := ",".join(missing) if missing else "ALL_CACHED")
`;
	const r = spawnSync(python, ["-c", probe], { encoding: "utf8", timeout: 60_000, windowsHide: true });
	const out = (r.stdout ?? "").trim();
	if (r.status !== 0 || !out) {
		// 探测失败:保守视为全部缺失
		return { ok: false, missing: [...models], cacheDir: modelCacheDir() };
	}
	return {
		ok: out === "ALL_CACHED",
		missing: out === "ALL_CACHED" ? [] : out.split(",").filter(Boolean),
		cacheDir: modelCacheDir(),
	};
}

/**
 * 确保 PP-StructureV3 模型就绪(缺失时联网下载到本地缓存)。
 * 注意:此步骤**不设置** PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK(允许下载);
 * 运行时(ppstructure_md.py)才启用离线模式。
 * @param {string} python
 * @param {{formula?: boolean, seal?: boolean, chart?: boolean}} [features]
 * @param {(msg: string) => void} [onLog]
 * @returns {{ ok: boolean, downloaded: string[], error?: string }}
 */
export function ensureOcrModels(python, features = {}, onLog) {
	const status = ocrModelCacheStatus(python, features);
	// 已缓存且未启用可选模块 → 直接就绪;启用可选模块时即使已知模型已缓存,
	// 也构造一次引擎,触发印章/图表等按需模型的就绪校验/下载。
	if (status.ok && !anyFeature(features)) {
		return { ok: true, downloaded: [] };
	}
	if (typeof onLog === "function") {
		onLog(
			anyFeature(features)
				? `校验/下载可选模块模型(公式/印章/图表,请保持网络通畅)...`
				: `模型未就绪,开始联网下载(${status.missing.length} 个,首次约数百 MB,请保持网络通畅)...`,
		);
	}
	// 与 ppstructure_md.py 运行时相同配置构造引擎 → 触发缺失模型下载
	const snippet = `
import time
from paddleocr import PPStructureV3
t = time.time()
engine = PPStructureV3(
    lang="ch",
    use_doc_orientation_classify=True,
    use_doc_unwarping=True,
    use_textline_orientation=True,
    use_formula_recognition=${features.formula ? "True" : "False"},
    use_seal_recognition=${features.seal ? "True" : "False"},
    use_chart_recognition=${features.chart ? "True" : "False"},
    text_detection_model_name=${features.fast ? '"PP-OCRv5_mobile_det"' : "None"},
    text_recognition_model_name=${features.fast ? '"PP-OCRv5_mobile_rec"' : "None"},
    enable_mkldnn=False,
)
print("MODELS_READY in %.0fs" % (time.time() - t))
`;
	const r = spawnSync(python, ["-c", snippet], {
		encoding: "utf8",
		timeout: 1_800_000, // 大模型下载可能较久
		windowsHide: true,
	});
	const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	if (r.status !== 0 || !/MODELS_READY/.test(text)) {
		const tail = text.split("\n").slice(-6).join("\n");
		return {
			ok: false,
			downloaded: [],
			error: `PP-StructureV3 模型就绪失败(需要网络):${tail || "(无输出)"}`,
		};
	}
	const after = ocrModelCacheStatus(python, features);
	return { ok: true, downloaded: after.missing.length === 0 ? [...status.missing] : [] };
}

/**
 * dsh-md-convert — OCR 依赖检测与自动安装
 *
 * 扫描件 OCR 依赖:Python + paddlepaddle + paddleocr + paddlex[ocr] + pypdfium2。
 *
 * 策略:
 *   - 检测:用 importlib.util.find_spec 快速探测(不实际 import,避免加载 paddle);
 *   - 已装 → 直接使用;缺失 → 按 autoInstall 决定自动 pip 安装或给出指引;
 *   - 安装幂等:只装缺失的包,已有跳过。
 */
import { spawnSync } from "node:child_process";

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

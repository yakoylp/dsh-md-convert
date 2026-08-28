/**
 * dsh-md-convert — 老二进制 Office 格式转换(doc/xls/ppt → docx/xlsx/pptx)
 *
 * 链路:老格式 → (WPS 或 MS Office COM / LibreOffice headless 另存为) → 现代格式 → markitdown。
 *
 * 后端选择(可用 `legacy.backend` 配置,默认 auto):
 *   auto        — Windows: wps → office(COM);Linux/macOS: libreoffice
 *   wps         — KWps.Application(文字) / KET.Application(表格) / KWPP.Application(演示) [Windows]
 *   office      — Word.Application / Excel.Application / PowerPoint.Application [Windows]
 *   libreoffice — soffice --headless --convert-to [跨平台]
 *
 * COM 实现说明:
 *   - 通过 powershell.exe -File 执行 COM 脚本(脚本写入临时目录,避免命令行引号转义);
 *   - 每次转换使用独立临时文件,由上层 TempScope 统一清理;
 *   - COM 对象显式 Quit,异常时同样释放(不影响调用方主流程)。
 */
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { LEGACY_MAP } from "./detect.js";

/** 各应用对应的 COM ProgID(优先 WPS,回退 Office) */
const COM_PROGIDS = {
	wps: {
		doc: "KWps.Application",
		xls: "KET.Application",
		ppt: "KWPP.Application",
	},
	office: {
		doc: "Word.Application",
		xls: "Excel.Application",
		ppt: "PowerPoint.Application",
	},
};

/**
 * 生成针对某一应用的 COM 另存为脚本。
 * @param {string} kind doc|xls|ppt
 * @param {string} backend wps|office
 */
function buildScript(kind, backend) {
	const progId = COM_PROGIDS[backend][kind];
	// 注意:模板内 PowerShell 变量只能写 $Name,不能写 ${Name}(会被 JS 模板插值)
	// finally 中的 COM 清理调用必须吞掉异常(如 Quit 时的 RPC 错误),否则会污染退出码
	if (kind === "doc") {
		return `
param([string]$Src, [string]$Out, [int]$Format)
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject '${progId}'
$app.Visible = $false
try {
  $doc = $app.Documents.Open($Src, $false, $true)
  $doc.SaveAs2($Out, $Format)
  $doc.Close($false)
  Write-Output "OK:$Out"
} finally {
  try { $app.Quit() } catch { }
}
`;
	}
	if (kind === "xls") {
		return `
param([string]$Src, [string]$Out, [int]$Format)
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject '${progId}'
$app.Visible = $false
try {
  $wb = $app.Workbooks.Open($Src)
  $wb.SaveAs($Out, $Format)
  $wb.Close($false)
  Write-Output "OK:$Out"
} finally {
  try { $app.Quit() } catch { }
}
`;
	}
	// ppt
	return `
param([string]$Src, [string]$Out, [int]$Format)
$ErrorActionPreference = 'Stop'
$app = New-Object -ComObject '${progId}'
try {
  $prs = $app.Presentations.Open($Src)
  $prs.SaveAs($Out, $Format)
  $prs.Close()
  Write-Output "OK:$Out"
} finally {
  try { $app.Quit() } catch { }
}
`;
}

/** 另存为格式号(与 MS Office 兼容,WPS 亦接受) */
const FORMATS = {
	doc: { docx: 12, docm: 16 }, // wdFormatXMLDocument / wdFormatXMLDocumentMacroEnabled
	xls: { xlsx: 51, xlsm: 52 }, // xlOpenXMLWorkbook / xlOpenXMLWorkbookMacroEnabled
	ppt: { pptx: 24, pptm: 25 }, // ppSaveAsOpenXMLPresentation / ppSaveAsOpenXMLPresentationMacroEnabled
};

function runPowershell(scriptPath, args) {
	const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], {
		encoding: "utf8",
		timeout: 180_000,
		windowsHide: true,
	});
	return r;
}

/**
 * 带重试的 COM 转换调用。用户正在运行的 WPS/Office 实例会让 COM 服务器
 * 短暂拒绝新调用(RPC_E_CALL_REJECTED 等),等待后重试即可,不能杀用户进程。
 * @param {string} scriptPath
 * @param {string[]} args
 * @param {number} [retries=3]
 */
function runPowershellRetry(scriptPath, args, retries = 3) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		const r = runPowershell(scriptPath, args);
		const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
		if (r.status === 0 && /^OK:/m.test(text)) return r;
		// 退避:COM 服务器忙时短暂等待
		if (attempt < retries) {
			try { execFileSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 2500"], { windowsHide: true, timeout: 10_000 }); } catch { /* 忽略 */ }
		}
	}
	return { status: -1, stdout: "", stderr: "retries exhausted" };
}

/**
 * 探测指定后端在哪种应用上可用(创建 COM 实例即视为可用)。
 * @param {"wps"|"office"} backend
 * @param {"doc"|"xls"|"ppt"} kind
 */
export function probeBackend(backend, kind) {
	const progId = COM_PROGIDS[backend]?.[kind];
	if (!progId) return false;
	const script = `
$ErrorActionPreference = 'SilentlyContinue'
try {
  $app = New-Object -ComObject '${progId}'
  if ($app -ne $null) { $app.Quit(); Write-Output 'OK' }
} catch { }
`;
	const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
		encoding: "utf8",
		timeout: 60_000,
		windowsHide: true,
	});
	return r.status === 0 && /OK/.test(r.stdout ?? "");
}

/* ------------------------------------------------------------------ *
 * LibreOffice headless 后端(跨平台;Linux/macOS 默认,Windows 可显式指定)
 * ------------------------------------------------------------------ */

const LIBREOFFICE_CANDIDATES = ["soffice", "libreoffice"];

/** 常用安装路径兜底(PATH 未收录时) */
function libreOfficeInstallPaths() {
	const list = [];
	if (process.platform === "win32") {
		list.push(
			"C:\\Program Files\\LibreOffice\\program\\soffice.exe",
			"C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
		);
	} else if (process.platform === "darwin") {
		list.push("/Applications/LibreOffice.app/Contents/MacOS/soffice");
	}
	return list;
}

/** 在 PATH 与常见安装路径中定位 LibreOffice 可执行文件;找不到返回 null */
export function findLibreOffice() {
	for (const cmd of LIBREOFFICE_CANDIDATES) {
		const r = spawnSync(cmd, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
		if (r.status === 0 && /libreoffice/i.test(`${r.stdout ?? ""}${r.stderr ?? ""}`)) return cmd;
	}
	for (const p of libreOfficeInstallPaths()) {
		try {
			if (p && existsSync(p)) return p;
		} catch { /* 忽略 */ }
	}
	return null;
}

/** 同步短暂睡眠(主线程 Atomics.wait,不依赖平台命令) */
function sleepSync(ms) {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch { /* 忽略 */ }
}

/**
 * 通过 LibreOffice headless 将老格式另存为现代格式。
 * soffice 输出到 outDir 下的 `<源名去扩展名>.<targetExt>`;失败重试 2 次
 * (LibreOffice profile 初始化偶发失败)。
 * @param {string} src 源文件(doc/xls/ppt)
 * @param {string} outDir 输出目录(临时)
 * @param {"doc"|"xls"|"ppt"} ext
 * @returns {{ ok: boolean, out?: string, error?: string }}
 */
function convertViaLibreOffice(src, outDir, ext) {
	const targetExt = LEGACY_MAP[ext];
	const soffice = findLibreOffice();
	if (!soffice) {
		return {
			ok: false,
			error:
				"未找到 LibreOffice(soffice)。请安装后重试(Linux: apt install libreoffice;Windows: https://www.libreoffice.org/download/)",
		};
	}
	const base = src.split(/[\\/]/).pop().replace(/\.\w+$/, "");
	const expected = join(outDir, `${base}.${targetExt}`);
	const env = { ...process.env };
	if (!env.HOME) env.HOME = tmpdir(); // 无头容器/服务器兜底
	let last = "";
	for (let attempt = 0; attempt <= 2; attempt++) {
		try { if (existsSync(expected)) rmSync(expected, { force: true }); } catch { /* 忽略 */ }
		const r = spawnSync(
			soffice,
			["--headless", "--norestore", "--convert-to", targetExt, "--outdir", outDir, src],
			{ encoding: "utf8", timeout: 180_000, windowsHide: true, env },
		);
		last = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
		if (r.status === 0 && existsSync(expected)) {
			return { ok: true, out: expected };
		}
		if (attempt < 2) sleepSync(2000);
	}
	const tail = last.split("\n").slice(-5).join("\n") || "(无输出)";
	return { ok: false, error: `LibreOffice 转换失败(${ext} → ${targetExt}):${tail}` };
}

/**
 * auto 分流:Windows 优先 COM(wps → office),其余平台用 LibreOffice。
 * @param {NodeJS.Platform} [platform]
 */
export function autoBackends(platform = process.platform) {
	return platform === "win32" ? ["wps", "office"] : ["libreoffice"];
}

/** 全部可用后端(校验用) */
export const LEGACY_BACKENDS = ["auto", "wps", "office", "libreoffice"];

/**
 * 将老格式文件另存为现代格式。
 * @param {string} src 源文件(doc/xls/ppt)
 * @param {string} outDir 输出目录(临时)
 * @param {object} [opts]
 * @param {"auto"|"wps"|"office"|"libreoffice"} [opts.backend="auto"] 首选后端;auto 按平台分流
 * @returns {{ ok: boolean, out?: string, backend?: string, error?: string }}
 */
export function convertLegacy(src, outDir, opts = {}) {
	const backend = opts.backend ?? "auto";
	const ext = src.split(".").pop().toLowerCase();
	const targetExt = LEGACY_MAP[ext];
	if (!targetExt) return { ok: false, error: `unsupported legacy extension: ${ext}` };

	const base = src.split(/[\\/]/).pop().replace(/\.\w+$/, "");
	const out = join(outDir, `${base}.${targetExt}`);
	const format = FORMATS[ext][targetExt];
	if (format === undefined) return { ok: false, error: `no target format for ${ext} → ${targetExt}` };

	const candidates = backend === "auto" ? autoBackends() : [backend];
	for (const b of candidates) {
		if (b === "libreoffice") {
			try {
				const r = convertViaLibreOffice(src, outDir, ext);
				if (r.ok) return { ok: true, out: r.out, backend: "libreoffice" };
			} catch { /* 继续尝试下一后端 */ }
			continue;
		}
		// COM 后端(wps / office)
		if (!COM_PROGIDS[b]?.[ext]) continue;
		if (backend === "auto" && !probeBackend(b, ext)) continue;
		try {
			const scriptPath = join(outDir, `com-${b}-${ext}.ps1`);
			writeFileSync(scriptPath, buildScript(ext, b), "utf8");
			const r = runPowershellRetry(scriptPath, [src, out, String(format)]);
			const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
			if (r.status === 0 && /^OK:/m.test(text) && existsSync(out)) {
				return { ok: true, out, backend: b };
			}
			// 该后端失败,清理半成品后尝试下一个
			try { if (existsSync(out)) rmSync(out, { force: true }); } catch { /* 忽略 */ }
		} catch (e) {
			// 继续尝试下一个后端
		}
	}
	return { ok: false, error: `legacy conversion failed (${ext}); tried backend(s): ${candidates.join(", ")}` };
}

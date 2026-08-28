/**
 * dsh-md-convert — 老二进制 Office 格式转换(doc/xls/ppt → docx/xlsx/pptx)
 *
 * 链路:老格式 → (WPS 或 MS Office COM 另存为) → 现代格式 → markitdown。
 *
 * COM 后端探测顺序(可用 `legacy.backend` 配置):
 *   1. wps    — KWps.Application(文字) / KET.Application(表格) / KWPP.Application(演示)
 *   2. office — Word.Application / Excel.Application / PowerPoint.Application
 *
 * 实现说明:
 *   - 通过 powershell.exe -File 执行 COM 脚本(脚本写入临时目录,避免命令行引号转义);
 *   - 每次转换使用独立临时文件,由上层 TempScope 统一清理;
 *   - COM 对象显式 Quit,异常时同样释放(不影响调用方主流程)。
 */
import { writeFileSync, existsSync, rmSync } from "node:fs";
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

/**
 * 将老格式文件另存为现代格式。
 * @param {string} src 源文件(doc/xls/ppt)
 * @param {string} outDir 输出目录(临时)
 * @param {object} [opts]
 * @param {"wps"|"office"|"auto"} [opts.backend="auto"] 首选后端;auto 时 wps → office
 * @returns {{ ok: boolean, out?: string, error?: string }}
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

	const candidates = backend === "auto" ? ["wps", "office"] : [backend];
	for (const b of candidates) {
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

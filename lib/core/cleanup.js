/**
 * dsh-md-convert — 临时目录与清理
 *
 * 转换过程会产生中间文件(老格式另存结果、PDF 渲染页、OCR 图片等),
 * 全部放在一次转换专属的临时目录中,转换结束后统一删除。
 * 即使进程异常退出,`cleanup()` 也会兜底尝试删除(进程内信号 + 下次运行清扫残留)。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "dsh-md-convert-";

/** 进程级会话临时根(惰性创建,进程退出时自动清扫) */
let sessionRoot = null;
let exitRegistered = false;
let signalRegistered = false;

function cleanupAll() {
	try {
		if (sessionRoot && existsSync(sessionRoot)) rmSync(sessionRoot, { recursive: true, force: true });
	} catch { /* 忽略 */ }
}

function ensureSessionRoot() {
	if (sessionRoot && existsSync(sessionRoot)) return sessionRoot;
	// 目录名带 pid:sweepStale 据此只清理已死进程的残留,不误删并发运行的其它进程/转换
	sessionRoot = mkdtempSync(join(tmpdir(), `${PREFIX}${process.pid}-`));
	if (!exitRegistered) {
		exitRegistered = true;
		process.once("exit", cleanupAll);
	}
	return sessionRoot;
}

/**
 * 安装 SIGINT/SIGTERM 清理钩子并在清理后主动退出。
 * 仅供 CLI 独立进程调用:作为 DSH 插件(agent 工具)运行于宿主进程时**不得**调用,
 * 否则会在宿主优雅停机(会话日志落盘、drain)之前 process.exit。
 */
export function installSignalCleanup() {
	if (signalRegistered) return;
	signalRegistered = true;
	process.once("SIGINT", () => { cleanupAll(); process.exit(130); });
	process.once("SIGTERM", () => { cleanupAll(); process.exit(143); });
}

/**
 * 为一次转换创建专属临时目录。
 * @param {string} [tag] 用途标识(legacy/ocr/pages),用于可读性
 * @returns {string} 临时目录绝对路径
 */
export function makeTempDir(tag = "tmp") {
	const root = ensureSessionRoot();
	return mkdtempSync(join(root, `${tag}-`));
}

/**
 * 递归删除目录/文件(不存在时静默)。
 * @param {string} p 路径
 */
export function cleanup(p) {
	try {
		if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
	} catch { /* 删除失败不阻断主流程,由下次会话清扫兜底 */ }
}

/**
 * 一次转换的临时目录作用域:在 finally 中调用 dispose() 即可保证清理。
 */
export class TempScope {
	/** @type {string[]} */
	#dirs = [];

	/** 新建一个受管临时目录 */
	dir(tag = "tmp") {
		const d = makeTempDir(tag);
		this.#dirs.push(d);
		return d;
	}

	/** 登记一个外部临时文件/目录,随作用域一起清理 */
	track(p) {
		if (p) this.#dirs.push(p);
		return p;
	}

	/** 删除本次转换产生的全部临时路径 */
	dispose() {
		for (const d of this.#dirs.splice(0)) cleanup(d);
	}
}

/** 判断 pid 是否对应一个存活进程(跨平台尽力而为)。 */
function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e?.code === "EPERM"; // EPERM:进程存在但无权限;ESRCH 等:不存在
	}
}

/**
 * 清扫遗留的 dsh-md-convert 临时目录(旧进程崩溃残留)。
 * 目录名含 `<pid>-`,只清理 pid 已死的目录,避免误删并发运行的其它进程/转换;
 * 旧版(无 pid)目录只清理符合 mkdtemp 格式(`dsh-md-convert-<6位字母数字>`)的,
 * 其它同名前缀目录(可能是用户自建)一律不碰。
 */
export function sweepStale() {
	try {
		const base = tmpdir();
		for (const name of readdirSync(base)) {
			if (!name.startsWith(PREFIX)) continue;
			const rest = name.slice(PREFIX.length);
			const m = /^(\d+)-/.exec(rest);
			if (m) {
				const pid = Number(m[1]);
				if (pid === process.pid) continue; // 本进程自己的会话根
				if (!isProcessAlive(pid)) cleanup(join(base, name));
				continue;
			}
			// 旧版 mkdtemp 残留(无 pid);只删该格式,避免误删用户自建的目录
			if (/^[A-Za-z0-9]{6}$/.test(rest)) cleanup(join(base, name));
		}
	} catch { /* 忽略 */ }
}

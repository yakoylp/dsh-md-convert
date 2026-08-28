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
let registered = false;

function ensureSessionRoot() {
	if (sessionRoot && existsSync(sessionRoot)) return sessionRoot;
	sessionRoot = mkdtempSync(join(tmpdir(), PREFIX));
	if (!registered) {
		registered = true;
		const cleanupAll = () => {
			try {
				if (sessionRoot && existsSync(sessionRoot)) rmSync(sessionRoot, { recursive: true, force: true });
			} catch { /* 忽略 */ }
		};
		process.once("exit", cleanupAll);
		process.once("SIGINT", () => { cleanupAll(); process.exit(130); });
		process.once("SIGTERM", () => { cleanupAll(); process.exit(143); });
	}
	return sessionRoot;
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

/** 清扫遗留的 dsh-md-convert 临时目录(旧进程崩溃残留) */
export function sweepStale() {
	try {
		const base = tmpdir();
		for (const name of readdirSync(base)) {
			if (name.startsWith(PREFIX)) {
				cleanup(join(base, name));
			}
		}
	} catch { /* 忽略 */ }
}

/**
 * dsh-md-convert — 内容寻址转换缓存
 *
 * 不建数据库:缓存文件名 = 内容哈希 + 选项指纹,命中 = 文件存在。
 *   <contentHash16>.<optHash8>.md    转换正文(不含标题/溯源注释)
 *   <contentHash16>.<optHash8>.json  { v, chain, warnings, convertedAt, sourceName, sourceSize, mdSize }
 *   .tmp/                            原子写临时文件(rename 落盘)
 *
 * 同机所有 agent / 会话 / profile 共享同一缓存目录(默认 $DSH_HOME/md-convert-cache)。
 * 缓存失败一律降级:目录不可写、条目损坏、JSON 解析失败 → 视为未命中,转换照常进行。
 */
import { createHash } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 缓存键协议版本:转换逻辑变更且未升插件版本时手动 +1,使旧缓存整体失效。 */
export const CACHE_KEY_VERSION = 1;

const CACHE_FILE_RE = /^([0-9a-f]{16}\.[0-9a-f]{8})\.(?:md|json)$/;

/** DSH home:$DSH_HOME,否则 ~/.dsh */
function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/**
 * 解析缓存目录:显式配置 > MD_CONVERT_CACHE_DIR > $DSH_HOME/md-convert-cache。
 * @param {string} [configured]
 * @returns {string}
 */
export function resolveCacheDir(configured) {
	const explicit = configured || process.env.MD_CONVERT_CACHE_DIR;
	return resolve(explicit || join(dshHome(), "md-convert-cache"));
}

function packageVersion() {
	try {
		return require("../../package.json").version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** 流式 SHA-256;读取失败返回 null(缓存降级)。 */
async function hashFile(path) {
	try {
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(path)) hash.update(chunk);
		return hash.digest("hex");
	} catch {
		return null;
	}
}

/**
 * 选项指纹:只含影响转换结果的因素;标题/溯源注释属于输出组装,不参与。
 */
function optionFingerprint(ext, opts) {
	const fp = { v: CACHE_KEY_VERSION, ver: packageVersion() };
	if (ext === "pdf") {
		fp.forceOcr = opts.forceOcr === true;
		fp.ocrScale = Number(opts.ocrScale) || 2;
	} else if (ext === "doc" || ext === "xls" || ext === "ppt") {
		fp.legacyBackend = opts.legacy?.backend ?? "auto";
	}
	return JSON.stringify(fp);
}

/**
 * 计算缓存键(内容哈希 + 选项指纹)。文件不可读时返回 null。
 * @param {string} inputPath
 * @param {string} ext 已归一化的小写扩展名
 * @param {object} opts 转换选项
 * @returns {Promise<{ key: string, contentHash: string } | null>}
 */
export async function cacheKey(inputPath, ext, opts) {
	const contentHash = await hashFile(inputPath);
	if (!contentHash) return null;
	const optHash = createHash("sha256").update(optionFingerprint(ext, opts)).digest("hex").slice(0, 8);
	return { key: `${contentHash.slice(0, 16)}.${optHash}`, contentHash: contentHash.slice(0, 16) };
}

/** 命中时刷新 mtime(LRU 依据);失败不影响命中。 */
function touch(path) {
	try {
		const now = new Date();
		utimesSync(path, now, now);
	} catch { /* 忽略 */ }
}

/**
 * 读取缓存条目;不存在、损坏或截断返回 null。
 * @param {string} dir
 * @param {string} key
 * @returns {{ md: string, meta: object } | null}
 */
export function readCache(dir, key) {
	const mdPath = join(dir, `${key}.md`);
	const metaPath = join(dir, `${key}.json`);
	try {
		if (!existsSync(mdPath) || !existsSync(metaPath)) return null;
		const meta = JSON.parse(readFileSync(metaPath, "utf8"));
		const md = readFileSync(mdPath, "utf8");
		if (typeof meta?.mdSize === "number" && Buffer.byteLength(md, "utf8") !== meta.mdSize) return null;
		if (!md.trim()) return null;
		touch(mdPath);
		touch(metaPath);
		return { md, meta };
	} catch {
		return null;
	}
}

/**
 * 原子写入缓存条目;失败返回 false(不阻断转换)。
 * @param {string} dir
 * @param {string} key
 * @param {{ md: string, chain: string, warnings?: string[], convertedAt?: string, sourceName?: string, sourceSize?: number }} payload
 * @returns {boolean}
 */
export function writeCache(dir, key, payload) {
	try {
		mkdirSync(dir, { recursive: true });
		const tmpDir = join(dir, ".tmp");
		mkdirSync(tmpDir, { recursive: true });
		const stamp = `${process.pid}.${Date.now().toString(36)}`;
		const mdTmp = join(tmpDir, `${key}.md.${stamp}`);
		const metaTmp = join(tmpDir, `${key}.json.${stamp}`);
		const md = payload.md ?? "";
		const meta = {
			v: CACHE_KEY_VERSION,
			chain: payload.chain ?? "",
			warnings: payload.warnings ?? [],
			convertedAt: payload.convertedAt ?? new Date().toISOString(),
			sourceName: payload.sourceName ?? "",
			sourceSize: payload.sourceSize ?? 0,
			mdSize: Buffer.byteLength(md, "utf8"),
		};
		writeFileSync(mdTmp, md, "utf8");
		writeFileSync(metaTmp, JSON.stringify(meta), "utf8");
		renameSync(mdTmp, join(dir, `${key}.md`));
		renameSync(metaTmp, join(dir, `${key}.json`));
		return true;
	} catch {
		return false;
	}
}

/** 进程内单飞:同一 key 的并发转换只执行一次。 */
const inflight = new Map();

/**
 * 按 key 合并并发任务。
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function singleFlight(key, task) {
	const running = inflight.get(key);
	if (running !== undefined) return running;
	const promise = (async () => {
		try {
			return await task();
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, promise);
	return promise;
}

/** 按 key 归组缓存文件(每个条目 2 个文件)。 */
function collectEntries(dir) {
	const byKey = new Map();
	try {
		for (const name of readdirSync(dir)) {
			const match = CACHE_FILE_RE.exec(name);
			if (!match) continue;
			let info;
			try {
				info = statSync(join(dir, name));
			} catch {
				continue;
			}
			const key = match[1];
			const current = byKey.get(key);
			if (current) {
				current.size += info.size;
				current.mtimeMs = Math.min(current.mtimeMs, info.mtimeMs);
				current.files.push(name);
			} else {
				byKey.set(key, { size: info.size, mtimeMs: info.mtimeMs, files: [name] });
			}
		}
	} catch { /* 目录不存在 */ }
	return [...byKey.entries()].map(([key, value]) => ({ key, ...value }));
}

/**
 * 缓存统计。
 * @param {string} dir
 * @returns {{ dir: string, entries: number, bytes: number }}
 */
export function cacheStatus(dir) {
	const entries = collectEntries(dir);
	return {
		dir,
		entries: entries.length,
		bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
	};
}

/**
 * 清空缓存:只删缓存文件与 .tmp,目录内其它文件不动。
 * @param {string} dir
 * @returns {{ dir: string, removed: number }}
 */
export function cacheClear(dir) {
	let removed = 0;
	for (const entry of collectEntries(dir)) {
		for (const name of entry.files) {
			try {
				unlinkSync(join(dir, name));
				removed++;
			} catch { /* 忽略 */ }
		}
	}
	try {
		rmSync(join(dir, ".tmp"), { recursive: true, force: true });
	} catch { /* 忽略 */ }
	return { dir, removed };
}

/**
 * 按上限清理:先删超过 maxAgeDays 的条目,再按 mtime 从旧到新删到 maxBytes 以下。
 * @param {string} dir
 * @param {{ maxBytes?: number, maxAgeDays?: number }} [limits]
 * @returns {{ dir: string, removed: number }}
 */
export function cachePrune(dir, limits = {}) {
	const maxBytes = Number(limits.maxBytes) || 0;
	const maxAgeDays = Number(limits.maxAgeDays) || 0;
	const ageLimit = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86_400_000 : null;
	let removed = 0;
	const keep = [];
	for (const entry of collectEntries(dir)) {
		if (ageLimit !== null && entry.mtimeMs < ageLimit) {
			for (const name of entry.files) {
				try {
					unlinkSync(join(dir, name));
					removed++;
				} catch { /* 忽略 */ }
			}
		} else {
			keep.push(entry);
		}
	}
	let total = keep.reduce((sum, entry) => sum + entry.size, 0);
	if (maxBytes > 0 && total > maxBytes) {
		keep.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const entry of keep) {
			if (total <= maxBytes) break;
			for (const name of entry.files) {
				try {
					unlinkSync(join(dir, name));
					removed++;
					total -= Math.round(entry.size / entry.files.length);
				} catch { /* 忽略 */ }
			}
		}
	}
	return { dir, removed };
}

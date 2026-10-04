/**
 * dsh-md-convert — markitdown 访问层
 *
 * 对外只暴露 convertWithMarkItDown(input, cfg):把源文件转成 Markdown 文本。
 * 默认走**子进程**(worker),可用 cfg.mode = "in-process" 回退到进程内直连。
 *
 * 为什么默认子进程:
 *   DSH 宿主会为 profile 内模块安装「插件依赖路由层」,它在解析 CJS 请求时会把
 *   `pkg/` 形式的请求剥成包名再调用 `require.resolve.paths(包名)`;若剥出的名字
 *   是 Node 内置模块名(tr46 为取 npm 版 punycode 写的 `require("punycode/")`
 *   就会被剥成 `punycode`),该调用返回 null,随后 for...of 抛 TypeError
 *   (@deepseek-ai/dsh-app-boot lib/index.js 的 routeScoped)。
 *   markitdown-node 顶层 require jsdom,jsdom → whatwg-url → tr46 是固定依赖链,
 *   因此**只要在宿主进程内加载 markitdown-node 就必然失败**;独立进程没有该路由层。
 *   附带收益:jsdom/sharp 等重依赖的加载与开销不再留在长驻宿主进程里。
 *
 * 配置(cordis.patch.yml 的 config.markitdown,均可省略):
 *   mode:      "worker"(默认)| "in-process"
 *   node:      指定运行 worker 的解释器(默认自动:Electron 宿主用自身二进制 +
 *              ELECTRON_RUN_AS_NODE,其它场景用 process.execPath);也可用环境变量
 *              DSH_MD_CONVERT_NODE 覆盖
 *   timeoutMs: worker 超时毫秒,0(默认)表示不超时
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAsync } from "./spawn.js";
import { makeTempDir, cleanup } from "./cleanup.js";
import { err, ERROR_CODES } from "./errors.js";

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "markitdown-worker.mjs");

/** markitdown 默认转换选项(worker 与 in-process 两条路径共用同一份,避免漂移) */
const DEFAULT_MARKITDOWN_OPTIONS = {
	ocrLanguages: "chi_sim+eng",
	extractTables: true,
	extractImages: false,
};

const DEFAULT_CFG = { mode: "worker", node: "", timeoutMs: 0 };

/**
 * 解析运行 worker 的解释器。
 * Electron 宿主里 process.execPath 是 Electron 二进制,加 ELECTRON_RUN_AS_NODE=1 即成为纯 Node;
 * 独立 CLI(process.execPath 就是 node)与自定义解释器都直接使用。
 */
function resolveWorkerNode(cfg) {
	const explicit = String(cfg.node || process.env.DSH_MD_CONVERT_NODE || "").trim();
	if (explicit) return { cmd: explicit, extraEnv: {} };
	if (process.versions.electron) return { cmd: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
	return { cmd: process.execPath, extraEnv: {} };
}

/**
 * 进程内直连 markitdown(旧实现,保留作诊断与无法 spawn 环境的逃生口)。
 * 注意:在 DSH 宿主进程内调用会因上述路由层缺陷失败,这是本模块默认改用子进程的原因。
 * @param {string} inputPath 源文件绝对路径
 * @returns {Promise<string>} Markdown 文本
 */
export async function convertInProcess(inputPath) {
	const { createRequire } = await import("node:module");
	const require = createRequire(import.meta.url);
	const { MarkItDown } = require("markitdown-node");
	const converter = new MarkItDown({ defaultOptions: DEFAULT_MARKITDOWN_OPTIONS });
	const result = await converter.convert(inputPath);
	if (result?.status !== "success") {
		throw err(ERROR_CODES.E_MARKITDOWN, `markitdown 转换失败:${(result?.errors ?? []).join("; ") || "未知原因"}`);
	}
	return result.markdown_content ?? "";
}

/**
 * 在子进程中转换:worker 把 { ok, markdown | error } 写入临时结果文件,父进程读取。
 * 不依赖 stdout,避免 markitdown/jsdom 的偶发输出污染结果。
 * @param {string} inputPath 源文件绝对路径
 * @param {object} cfg 见文件头配置说明
 * @returns {Promise<string>} Markdown 文本
 */
export async function convertViaWorker(inputPath, cfg = {}) {
	const { cmd, extraEnv } = resolveWorkerNode(cfg);
	const dir = makeTempDir("markitdown");
	const resultPath = join(dir, "result.json");
	try {
		const r = await runAsync(
			cmd,
			[WORKER_PATH, inputPath, resultPath, JSON.stringify(DEFAULT_MARKITDOWN_OPTIONS)],
			{ timeout: cfg.timeoutMs ?? 0, env: { ...process.env, ...extraEnv } },
		);
		if (r.error === "timeout") {
			throw err(ERROR_CODES.E_MARKITDOWN, `markitdown 子进程超时(${cfg.timeoutMs}ms):${inputPath}`);
		}
		if (r.error) {
			throw err(ERROR_CODES.E_MARKITDOWN, `无法启动 markitdown 子进程(${cmd}):${r.error}`);
		}
		let payload = null;
		try {
			payload = JSON.parse(readFileSync(resultPath, "utf8"));
		} catch {
			payload = null;
		}
		if (payload === null) {
			const tail = (r.stderr ?? "").trim().slice(-800) || "(无 stderr)";
			throw err(
				ERROR_CODES.E_MARKITDOWN,
				`markitdown 子进程未产出结果(退出码 ${r.status ?? "null"}):${tail}`,
			);
		}
		if (payload.ok !== true) {
			throw err(ERROR_CODES.E_MARKITDOWN, `markitdown 转换失败:${payload.error ?? "未知原因"}`);
		}
		return payload.markdown ?? "";
	} finally {
		cleanup(dir);
	}
}

/**
 * 转换入口:按 cfg.mode 选择子进程或进程内实现。
 * @param {string} inputPath 源文件绝对路径
 * @param {object} [cfg] markitdown 配置(见文件头)
 * @returns {Promise<string>} Markdown 文本
 */
export async function convertWithMarkItDown(inputPath, cfg = {}) {
	const merged = { ...DEFAULT_CFG, ...(cfg ?? {}) };
	if (merged.mode === "worker") return convertViaWorker(inputPath, merged);
	if (merged.mode === "in-process") return convertInProcess(inputPath);
	throw err(ERROR_CODES.E_MARKITDOWN, `未知的 markitdown 模式:${merged.mode}(可选 worker | in-process)`);
}

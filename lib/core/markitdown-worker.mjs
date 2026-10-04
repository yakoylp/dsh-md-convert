/**
 * dsh-md-convert — markitdown 子进程 worker
 *
 * 用途:在**独立进程**里加载 markitdown-node 并把结果写成 JSON 文件,供
 * lib/core/markitdown.js 读取。父进程(markitdown.js)负责 spawn 与错误映射。
 *
 * 为什么必须独立进程:
 *   DSH 宿主为 profile 内模块安装了「插件依赖路由层」。该层在解析 CJS 请求时,
 *   会把形如 `pkg/` 的请求剥成包名再调用 `require.resolve.paths(包名)`;当剥出的
 *   名字正好是 Node 内置模块名时(典型案例:tr46 为取 npm 版 punycode 而写的
 *   `require("punycode/")`,裸名被剥成 `punycode`),该调用返回 null,
 *   随后的 for...of 抛 TypeError(@deepseek-ai/dsh-app-boot lib/index.js 的
 *   routeScoped)。而 markitdown-node 顶层就 require jsdom,jsdom → whatwg-url
 *   → tr46 是固定依赖链,所以在宿主进程内加载 markitdown-node 必然踩中。
 *   独立进程没有该路由层,裸 require 按 Node 原生规则解析,一切正常。
 *
 * 用法(由 markitdown.js 调用,也可手工执行便于定位问题):
 *   node markitdown-worker.mjs <源文件> <结果JSON路径> [defaultOptionsJSON]
 *
 * 退出码:0 成功 / 1 转换失败 / 2 参数错误。结果一律写入结果文件,不依赖 stdout。
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [inputPath, resultPath, optionsJson] = process.argv.slice(2);

/** 结果写入失败时不抛错:父进程会按「无结果文件」归类为 E_MARKITDOWN。 */
function report(payload) {
	try {
		writeFileSync(resultPath, JSON.stringify(payload), "utf8");
	} catch { /* 交给父进程按缺失结果处理 */ }
}

if (!inputPath || !resultPath) {
	console.error("用法: node markitdown-worker.mjs <源文件> <结果JSON路径> [defaultOptionsJSON]");
	process.exit(2);
}

let defaultOptions = {};
if (optionsJson) {
	try {
		defaultOptions = JSON.parse(optionsJson);
	} catch {
		/* 选项非法则退回 markitdown 自身默认值,不因此失败 */
	}
}

try {
	// 本进程无 DSH 路由层;CJS 入口是 markitdown-node 唯一可用入口(其 ESM 入口内部 require 在纯 ESM 下不可用)
	const require = createRequire(import.meta.url);
	const { MarkItDown } = require("markitdown-node");
	const converter = new MarkItDown({ defaultOptions });
	const result = await converter.convert(inputPath);
	if (result?.status !== "success") {
		report({ ok: false, error: (result?.errors ?? []).join("; ") || "未知原因" });
		process.exit(1);
	}
	report({ ok: true, markdown: result.markdown_content ?? "" });
	process.exit(0);
} catch (error) {
	report({ ok: false, error: String(error?.message ?? error), stack: String(error?.stack ?? "") });
	process.exit(1);
}

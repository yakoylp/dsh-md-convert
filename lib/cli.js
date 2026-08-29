#!/usr/bin/env node
/**
 * dsh-md-convert — 命令行入口
 *
 * 用法:
 *   dsh-md-convert <文件...> -o <输出目录> [选项]
 *   dsh-md-convert check                # 检查 OCR 依赖状态
 *   dsh-md-convert deps                 # 检查并自动安装缺失的 OCR 依赖
 *
 * 示例:
 *   dsh-md-convert a.docx b.pdf -o ./md
 *   dsh-md-convert old.doc -o ./md --legacy-backend wps
 *   dsh-md-convert scan.pdf -o ./md --force-ocr        # 扫描件固定走 PP-StructureV3
 *
 * 退出码:
 *   0 全部成功   1 存在失败(含失败文件的错误码与路径)   2 参数错误
 */
import { createRequire } from "node:module";
import { convertMany } from "./core/convert.js";
import { formatError, ERROR_CODES } from "./core/errors.js";
import { ensureOcrDeps, detectPython, findMissingModules, PY_MODULES, ocrModelCacheStatus, ensureOcrModels } from "./core/deps.js";

const require = createRequire(import.meta.url);

function printHelp() {
	console.log(`dsh-md-convert — 将 Office / PDF 文档转换为结构级排版的 Markdown

用法:
  dsh-md-convert <文件...> -o <输出目录> [选项]
  dsh-md-convert check                    检查 OCR 依赖与模型缓存(不安装)
  dsh-md-convert deps                     安装缺失依赖并预下载 OCR 模型到本地(需联网一次,之后离线可用)

必选:
  -o, --out-dir <dir>          输出目录(生成的 .md 文件)

选项:
      --force-ocr              强制 PDF 走 OCR(扫描件自动识别,文字层空时自动回退)
      --ocr-scale <n>          PDF 渲染倍率(默认 2,约 144dpi)
      --ocr-python <path>      指定 Python 解释器(运行 OCR 流水线;留空自动探测 python/python3/py)
      --no-auto-install-deps   缺 OCR 依赖时不自动 pip 安装,直接报错(默认自动安装)
      --legacy-backend <b>     老格式转换后端: auto | wps | office | libreoffice(auto:Windows 用 wps/office COM,Linux/macOS 用 LibreOffice)
      --no-title               不在 md 开头加源文件名标题
      --no-meta                不追加转换溯源注释
      --no-overwrite           不覆盖已存在的 .md
      --keep-temp              保留临时文件(调试)
  -h, --help                   显示帮助
  -v, --version                显示版本

扫描件 OCR:
  模块化路由流水线(全部本地 CPU、轻量模型优先、性价比优先):
  PP-DocLayout-L 版面分析 → 按区域路由(RapidOCR 文字 / SLANet+RT-DETR 表格 /
  FormulaNet-S 公式 / 印章注释),标题层级由版面模型识别。
  首次转换时自动检测并安装缺失依赖:
    python -m pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2 rapidocr onnxruntime

退出码: 0 全部成功 / 1 存在失败(每行带 [错误码] 源文件 原因) / 2 参数错误`);
}

function parseArgs(argv) {
	const opts = { files: [], outDir: null, command: null };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case "check": case "deps": opts.command = a; break;
			case "-o": case "--out-dir": opts.outDir = next(); break;
			case "--force-ocr": opts.forceOcr = true; break;
			case "--ocr-scale": opts.ocrScale = Number(next()); break;
			case "--ocr-python": opts.ocrPython = next(); break;
			case "--no-auto-install-deps": opts.noAutoInstallDeps = true; break;
			case "--legacy-backend": opts.legacyBackend = next(); break;
			case "--no-title": opts.noTitle = true; break;
			case "--no-meta": opts.noMeta = true; break;
			case "--no-overwrite": opts.noOverwrite = true; break;
			case "--keep-temp": opts.keepTemp = true; break;
			case "-h": case "--help": printHelp(); process.exit(0); break;
			case "-v": case "--version": console.log(require("../package.json").version); process.exit(0); break;
			default:
				if (a.startsWith("-")) { console.error(`未知选项: ${a}`); printHelp(); process.exit(2); }
				opts.files.push(a);
		}
	}
	return opts;
}

/** check / deps 子命令:OCR 依赖 + 模型缓存状态 */
async function depsCommand(mode) {
	const python = detectPython();
	if (!python) {
		console.error("✗ 未找到 Python(需要 Python ≥3.8)。请先安装:https://www.python.org/downloads/");
		process.exit(1);
	}
	console.log(`✓ Python: ${python}`);

	// 1. Python 依赖(pip 包)
	const { missing } = findMissingModules(python);
	if (missing.length > 0) {
		console.log(`⚠ 缺少 OCR 模块: ${missing.join(", ")}`);
		if (mode !== "deps") {
			console.log(`  安装命令: python -m pip install ${missing.map((m) => PY_MODULES[m]).join(" ")}`);
			process.exit(1);
		}
		console.log("→ 开始安装 OCR 依赖...");
		const r = await ensureOcrDeps({ python, autoInstall: true, onLog: (m) => console.log(`  ${m}`) });
		if (!r.ok) {
			console.error(`✗ 安装失败:${r.error}`);
			process.exit(1);
		}
		console.log(`✓ 已安装: ${r.installed.join(", ")}`);
	} else {
		console.log("✓ OCR 依赖齐全: paddlepaddle / paddleocr / paddlex[ocr] / pypdfium2 / rapidocr / onnxruntime");
	}

	// 2. 路由 OCR 模型缓存(本地离线运行的前提)
	const modelStatus = ocrModelCacheStatus(python);
	if (modelStatus.ok) {
		console.log(`✓ OCR 模型已缓存(${modelStatus.cacheDir}),运行完全离线、不检查网络`);
		process.exit(0);
	}
	console.log(`⚠ 缺少 OCR 模型(${modelStatus.missing.length} 个): ${modelStatus.missing.join(", ")}`);
	if (mode !== "deps") {
		console.log("  请联网执行一次 `dsh-md-convert deps` 预下载模型(首次约数百 MB),之后离线可用");
		process.exit(1);
	}
	const m = await ensureOcrModels(python, (msg) => console.log(`  ${msg}`));
	if (!m.ok) {
		console.error(`✗ 模型就绪失败:${m.error}`);
		process.exit(1);
	}
	console.log("✓ OCR 模型已就绪(本地缓存,之后离线可用)");
	process.exit(0);
}

function buildConvertOpts(cli) {
	return {
		outDir: cli.outDir,
		forceOcr: cli.forceOcr,
		ocrScale: cli.ocrScale,
		ocr: { python: cli.ocrPython },
		autoInstallDeps: !cli.noAutoInstallDeps,
		legacy: { backend: cli.legacyBackend },
		title: !cli.noTitle,
		meta: !cli.noMeta,
		overwrite: !cli.noOverwrite,
		keepTemp: cli.keepTemp,
		onLog: (m) => console.log(`  ${m}`),
	};
}

/** 合法后端值(校验 --legacy-backend) */
const LEGACY_BACKEND_VALUES = new Set(["auto", "wps", "office", "libreoffice"]);

async function main() {
	const cli = parseArgs(process.argv.slice(2));

	if (cli.command === "check" || cli.command === "deps") {
		await depsCommand(cli.command);
		return;
	}

	if (cli.files.length === 0) {
		console.error("错误: 未指定输入文件。\n");
		printHelp();
		process.exit(2);
	}
	if (!cli.outDir) {
		console.error("错误: 缺少 -o/--out-dir。\n");
		printHelp();
		process.exit(2);
	}
	if (cli.legacyBackend && !LEGACY_BACKEND_VALUES.has(cli.legacyBackend)) {
		console.error(`错误: 无效的 --legacy-backend: ${cli.legacyBackend}(可选: auto | wps | office | libreoffice)\n`);
		printHelp();
		process.exit(2);
	}

	const results = await convertMany(cli.files, buildConvertOpts(cli));
	let failed = 0;
	for (const r of results) {
		if (r.ok) {
			console.log(`✓ ${r.chain}  → ${r.outFile}`);
			for (const w of r.warnings ?? []) console.warn(`  ⚠ ${w}`);
		} else {
			failed++;
			// 统一输出格式:✗ [错误码] 源文件: 原因
			console.error(`✗ ${formatError({ code: r.code, message: r.error })}  ${r.file}`);
		}
	}
	console.error(failed ? `\n${failed} 个文件转换失败(详见上方 [错误码] 行)` : "");
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error(`✗ ${formatError(e)}`);
	process.exit(1);
});

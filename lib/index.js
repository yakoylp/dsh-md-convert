/**
 * dsh-md-convert — cordis 插件入口(Node 半区)
 *
 * 向 agent 注册 `md_convert` 工具:把 Office / PDF 文档转换为结构级排版的
 * Markdown 文件并返回路径(输出到工作区内,便于会话引用)。
 *
 * 扫描件 OCR 走「模块化路由流水线」(PP-DocLayout-L 版面 → RapidOCR 文字 /
 * SLANet+RT-DETR 表格 / FormulaNet-S 公式),全部本地 CPU、轻量模型优先;首次使用自动
 * 检测并安装缺失的 Python 依赖(paddlepaddle/paddleocr/paddlex[ocr]/pypdfium2/
 * rapidocr/onnxruntime),并联网预下载 OCR 模型到本地缓存(之后完全离线)。
 *
 * 插件配置(cordis.patch.yml 的 config 行):
 *   config:
 *     outDir: ""            # 输出目录;空则使用会话工作区
 *     forceOcr: false       # 强制 PDF 走 OCR
 *     ocrScale: 2           # PDF 渲染倍率
 *     autoInstallDeps: true # 缺 OCR 依赖时自动 pip 安装
 *     ocr:
 *       python: ""          # Python 解释器(运行 OCR 流水线;空则自动探测)
 *     legacy:
 *       backend: "auto"     # auto | wps | office | libreoffice(auto:Windows 用 COM,其余平台用 LibreOffice)
 */
import { resolve } from "node:path";
import { convertFile } from "./core/convert.js";

export const name = "dsh-md-convert";

/** 工具注入所需的 cordis 服务(workspace 为可选,用 ctx.get 读取) */
export const inject = ["tools"];

export function apply(ctx, config = {}) {
	ctx.tools.register({
		name: "md_convert",
		description:
			"将 Office 文档(.doc/.docx/.xls/.xlsx/.ppt/.pptx)或 PDF(含扫描件," +
			"自动用模块化路由 OCR 做版面分析与识别)转换为保留结构级排版" +
			"(标题/列表/表格/段落)的 Markdown 文件,返回输出路径。" +
			"失败时返回稳定错误码: E_FILE_NOT_FOUND / E_UNSUPPORTED_FORMAT / " +
			"E_MARKITDOWN / E_LEGACY_CONVERT / E_OCR_DEPS / E_OCR_RUN / E_OCR_EMPTY / E_OUTPUT。",
		parameters: {
			type: "object",
			properties: {
				file: {
					type: "string",
					description: "要转换的源文件路径(绝对路径或相对工作区路径)",
				},
				outDir: {
					type: "string",
					description: "输出目录(可选;默认插件配置或工作区)",
				},
				forceOcr: {
					type: "boolean",
					description: "强制 PDF 走 OCR(默认自动:文字层为空时回退路由 OCR)",
				},
			},
			required: ["file"],
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", description: "转换是否成功" },
					output: { type: "string", description: "成功时输出的 Markdown 路径" },
					chain: { type: "array", items: { type: "string" }, description: "成功时使用的转换链路" },
					warnings: { type: "array", items: { type: "string" }, description: "成功时的警告列表" },
					code: { type: "string", description: "失败时的稳定错误码" },
					file: { type: "string", description: "失败时涉及的源文件" },
					error: { type: "string", description: "失败时的错误信息" },
				},
				required: ["ok"],
			},
			render: (_args, value) => [{
				type: "text",
				text: value.ok
					? `md_convert 完成: ${value.output}${value.chain?.length ? ` (${value.chain.join(" → ")})` : ""}`
					: `md_convert 失败 [${value.code}]: ${value.error ?? ""}`,
			}],
		},
		async execute(args, exec) {
			// raw 注册无入参校验,这里做基础类型防御。
			const file = args?.file;
			if (typeof file !== "string" || !file.trim()) {
				return {
					ok: false,
					code: "E_FILE_NOT_FOUND",
					file: String(file ?? ""),
					error: "缺少有效的 file 参数(需为字符串路径)",
				};
			}
			// 相对路径的基准是「会话工作区」(exec.agent.session.header.cwd),而非宿主进程的
			// process.cwd()——桌面部署下后者是 DSH 依赖目录,不是工作区。带盘符的绝对路径
			// 会被 path.resolve 正确保留(直接按绝对路径处理),与官方 dsh-tool-fs 的做法一致。
			const cwd = exec?.agent?.session?.header?.cwd ?? process.cwd();
			const src = resolve(cwd, file);
			const outArg = typeof args.outDir === "string" && args.outDir ? args.outDir : (config.outDir || cwd);
			const out = resolve(cwd, outArg);
			const forceOcr = typeof args.forceOcr === "boolean" ? args.forceOcr : config.forceOcr;
			const result = await convertFile(src, {
				outDir: out,
				forceOcr,
				ocrScale: config.ocrScale,
				ocr: config.ocr,
				autoInstallDeps: config.autoInstallDeps !== false,
				legacy: config.legacy,
			});
			if (!result.ok) {
				return {
					ok: false,
					code: result.code,
					file: result.file,
					error: result.error,
				};
			}
			return {
				ok: true,
				output: result.outFile,
				chain: result.chain,
				warnings: result.warnings,
			};
		},
	});
}

/**
 * dsh-md-convert — cordis 插件入口(Node 半区)
 *
 * 向 agent 注册 `md_convert` 工具:把 Office / PDF 文档转换为结构级排版的
 * Markdown 文件并返回路径(输出到工作区内,便于会话引用)。
 *
 * 扫描件 OCR 固定使用 PP-StructureV3(CPU 可跑,无需 GPU);首次使用自动
 * 检测并安装缺失的 Python 依赖(paddlepaddle/paddleocr/paddlex[ocr]/pypdfium2)。
 *
 * 插件配置(cordis.patch.yml 的 config 行):
 *   config:
 *     outDir: ""            # 输出目录;空则使用会话工作区
 *     forceOcr: false       # 强制 PDF 走 OCR
 *     ocrScale: 2           # PDF 渲染倍率
 *     autoInstallDeps: true # 缺 OCR 依赖时自动 pip 安装
 *     ocr:
 *       python: ""          # Python 解释器(运行 PP-StructureV3;空则自动探测)
 *     legacy:
 *       backend: "auto"     # auto | wps | office
 */
import { join } from "node:path";
import { convertFile } from "./core/convert.js";

export const name = "dsh-md-convert";

/** 工具注入所需的 cordis 服务 */
export const inject = ["fs", "workspace"];

export function apply(ctx) {
	const config = ctx.config ?? {};

	const outDir = () => {
		if (config.outDir) return config.outDir;
		try {
			const ws = ctx.get("workspace");
			const root = ws?.root ?? ws?.path;
			if (root) return root;
		} catch { /* 没有 workspace 服务时退回进程 cwd */ }
		return process.cwd();
	};

	ctx.tools.register("md_convert", {
		description:
			"将 Office 文档(.doc/.docx/.xls/.xlsx/.ppt/.pptx)或 PDF(含扫描件," +
			"自动用 PP-StructureV3 做版面分析与 OCR)转换为保留结构级排版" +
			"(标题/列表/表格/段落)的 Markdown 文件,返回输出路径。" +
			"失败时返回稳定错误码: E_FILE_NOT_FOUND / E_UNSUPPORTED_FORMAT / " +
			"E_MARKITDOWN / E_LEGACY_CONVERT / E_OCR_DEPS / E_OCR_RUN / E_OCR_EMPTY / E_OUTPUT。",
		input: {
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
					description: "强制 PDF 走 OCR(默认自动:文字层为空时回退 PP-StructureV3)",
				},
			},
			required: ["file"],
		},
		async run(args, exec) {
			const src = join(exec.cwd ?? process.cwd(), args.file);
			const result = await convertFile(src, {
				outDir: args.outDir || outDir(),
				forceOcr: args.forceOcr ?? config.forceOcr,
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

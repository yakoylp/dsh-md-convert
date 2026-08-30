/**
 * dsh-md-convert — 错误码定义
 *
 * 所有失败都携带稳定的错误码(code)与人类可读消息(error),
 * 调用方(CLI / agent 工具 / 二次开发)可据此分类处理。
 * 码值永不变更;新增错误只追加,不修改既有码。
 */
export const ERROR_CODES = {
	/** 源文件不存在或不可读 */
	E_FILE_NOT_FOUND: "E_FILE_NOT_FOUND",
	/** 输入扩展名不被任何链路支持 */
	E_UNSUPPORTED_FORMAT: "E_UNSUPPORTED_FORMAT",
	/** MarkItDown 转换失败(新格式/文字层 PDF) */
	E_MARKITDOWN: "E_MARKITDOWN",
	/** 老格式(doc/xls/ppt)经 WPS/Office COM 另存失败 */
	E_LEGACY_CONVERT: "E_LEGACY_CONVERT",
	/** 缺 Python / paddleocr / pypdfium2 等 OCR 依赖 */
	E_OCR_DEPS: "E_OCR_DEPS",
	/** 路由 OCR 执行失败(进程级) */
	E_OCR_RUN: "E_OCR_RUN",
	/** 路由 OCR 未识别出任何内容 */
	E_OCR_EMPTY: "E_OCR_EMPTY",
	/** 输出目录/文件写入失败 */
	E_OUTPUT: "E_OUTPUT",
	/** 其他未预期错误 */
	E_UNKNOWN: "E_UNKNOWN",
};

/** 构造携带错误码的 Error */
export function err(code, message) {
	const e = new Error(message);
	e.code = code;
	return e;
}

/** 从任意异常中提取错误码(无则 E_UNKNOWN) */
export function codeOf(e) {
	return (e && e.code && ERROR_CODES[e.code]) ? e.code : ERROR_CODES.E_UNKNOWN;
}

/** 格式化错误摘要: [E_XXX] 消息 */
export function formatError(e) {
	const msg = e?.message ?? String(e ?? "unknown error");
	return `[${codeOf(e)}] ${msg}`;
}

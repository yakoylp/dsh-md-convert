/**
 * dsh-md-convert — 格式检测与分类
 *
 * 将输入文件按处理链路分类:
 *  - modern   : markitdown 原生支持(docx/xlsx/pptx/pdf 文字层等)
 *  - legacy   : 老二进制格式,需先经 WPS/Office COM 另存为现代格式(doc/xls/ppt)
 *  - scanned  : 无文字层的 PDF(扫描件),需 OCR 后再进入 markitdown / 直接出 md
 *  - image    : 图片,直接交给 markitdown 的 OCR 能力(或标记为扫描页来源)
 */

const MODERN_EXT = new Set([
	"docx", "xlsx", "pptx",
	"pdf", "html", "htm", "csv", "json", "xml", "rss", "atom",
	"ipynb", "md", "markdown", "txt", "srt", "vtt",
	"png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp", "gif",
]);

/** 老二进制 Office 格式 → 目标现代格式 */
export const LEGACY_MAP = {
	doc: "docx",
	xls: "xlsx",
	ppt: "pptx",
};

/** 现代 Office/PDF 格式(核心目标) */
export const OFFICE_MODERN = new Set(["docx", "xlsx", "pptx", "pdf"]);

export function extOf(file) {
	const base = String(file).split(/[\\/]/).pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * 分类输入文件。
 * @param {string} file 文件路径
 * @param {object} [info] 可选的附加信息,如 { hasTextLayer: boolean }(PDF)
 * @returns {{ kind: "modern"|"legacy"|"scanned"|"unsupported", ext: string, targetExt?: string }}
 */
export function classify(file, info = {}) {
	const ext = extOf(file);
	if (Object.prototype.hasOwnProperty.call(LEGACY_MAP, ext)) {
		return { kind: "legacy", ext, targetExt: LEGACY_MAP[ext] };
	}
	if (ext === "pdf" && info.hasTextLayer === false) {
		return { kind: "scanned", ext };
	}
	if (MODERN_EXT.has(ext)) {
		return { kind: "modern", ext };
	}
	return { kind: "unsupported", ext };
}

/** markitdown 是否原生支持该扩展名 */
export function isModernExt(ext) {
	return MODERN_EXT.has(ext.toLowerCase());
}

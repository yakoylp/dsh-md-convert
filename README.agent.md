# dsh-md-convert — Agent 使用指南

> 面向 AI agent:`md_convert` 工具怎么用、何时用、出错怎么处理。人类用户请看 README.md / README.en.md。

## 工具是什么

`md_convert` 把 Office/PDF(含扫描件)转换为保留结构的 Markdown:

- `.docx/.xlsx/.pptx`、`.pdf`(有文字层)、`.doc/.xls/.ppt` → MarkItDown 直转
- `.pdf` 扫描件/无文字层 → **路由 OCR**(版面分析 + 文字/表格/公式识别),CPU 即可

**适用**:用户要求转 md、提取文档内容、批量转换。
**不适用**:只需读内容用 `pdf_read`/`docx_read` 等;生成文档用 `docx_create`/`pdf_create` 等;视觉保真(字体/颜色)Markdown 表达不了,直接告知用户。

## 怎么调用

```jsonc
// 单文件(推荐显式 outDir,避免与源文件混放)
md_convert({ "file": "contract.pdf", "outDir": "./md" })
// → { ok: true, output: "./md/contract.md", chain: "...", warnings?: [] }

// 强制扫描件路径(一般不需要:文字层为空自动回退 OCR)
md_convert({ "file": "scan.pdf", "forceOcr": true, "outDir": "./md" })
```

- `file`:绝对路径或相对工作区路径;`outDir` 缺省用会话工作区
- 输出名 = 源文件名去扩展名 + `.md`;同名默认覆盖
- 失败返回 `{ ok: false, code, file, error }`,`code` 是稳定错误码

## 错误码

| code | 含义 | 处理 |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | 文件不存在 | 核对路径后重试,别盲目重试 |
| `E_UNSUPPORTED_FORMAT` | 格式不支持 | 告知用户 |
| `E_MARKITDOWN` | MarkItDown 失败 | 多为损坏/加密;可重试一次 |
| `E_LEGACY_CONVERT` | 老格式(doc/xls/ppt)转换失败 | 需本机 WPS/Office 或 LibreOffice |
| `E_OCR_DEPS` | OCR 依赖缺失 | 让用户跑 `dsh-md-convert deps` |
| `E_OCR_RUN` | OCR 执行失败 | 重试;持续失败建议降 `--ocr-scale` |
| `E_OCR_EMPTY` | 未识别出内容 | 告知用户扫描质量差/过暗/方向异常 |
| `E_OUTPUT` | 输出写入失败 | 检查目录权限/磁盘 |

**报错时必带 `code` 和 `file`**,如:`[E_OCR_EMPTY] C:\docs\scan.pdf`。

## 批量约定

- 一次调用处理一个文件;批量就**循环调用**,按 `file` 定位失败,不依赖返回顺序
- 成功只报输出路径,**不要**把整份 md 贴回对话(费上下文),除非用户要求
- 同一 outDir 批量时同名会覆盖——需先与用户确认或用独立目录

## 注意

- **结构化而非视觉**:字体/字号/颜色/缩进不保留,主动告知用户
- 扫描件质量取决于清晰度;复杂表格/多栏/超小字号可能识别不全
- 首次使用自动装依赖(缺则 `pip install`)、联网下载 OCR 模型(数百 MB,之后完全离线);模型未就绪时提示用户跑 `dsh-md-convert deps`
- 源文件只读,绝不修改;临时文件自动清理

# dsh-md-convert

[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

将 Office 文档与 PDF(含扫描件)转换为**保留结构级排版**的 Markdown,基于 [MarkItDown](https://github.com/microsoft/markitdown) 引擎。提供 **CLI 命令行**与 **dsh agent 工具**(`md_convert`)双入口。

- **AI Agent 使用规范**:[README.agent.md](README.agent.md)(错误码处理/批量规范/调用约定)
- English: [README.en.md](README.en.md)

## 支持格式与转换链路

| 输入 | 链路 | 说明 |
| --- | --- | --- |
| `.docx` / `.xlsx` / `.pptx` | MarkItDown 直转 | 标题/列表/表格/段落保留为 Markdown |
| `.pdf`(含文字层) | MarkItDown 直转 | 文字层为空时**自动回退 PP-StructureV3** |
| `.pdf`(扫描件) | **PP-StructureV3**(版面分析 + OCR)→ Markdown | 标题/正文/表格/公式/印章按阅读顺序拼装,纯 CPU |
| `.doc` / `.xls` / `.ppt` | WPS/Office COM 另存为新格式 → MarkItDown | 后端自动探测,可配置 |
| `.html/.csv/.json/.xml/.ipynb/.md/.txt/...` | MarkItDown / 直接读取 | MarkItDown 支持的全部格式 |

> **"结构级排版"** = 标题层级(H1–H6)、列表、表格(管道表格)、段落顺序均保留。
> Markdown 本身无法表达字体/字号/颜色/缩进等视觉细节,任何转换器都不会保留它们——这是格式本质。

## 环境依赖

- **Node.js ≥ 18**
- 老格式转换(`.doc/.xls/.ppt`)需要本机装有 **WPS Office** 或 **Microsoft Office**(COM 自动探测)
- 扫描件 OCR **固定使用百度 PP-StructureV3**(CPU 即可,无需 GPU)

**依赖自动安装(默认开启)**:首次转换扫描件时,插件自动检测 Python 与 OCR 依赖
(`paddlepaddle` `paddleocr` `paddlex[ocr]` `pypdfium2`),**有则直接使用,缺则自动 `pip install`**,
无需手动操作。可用 `--no-auto-install-deps` 关闭,或手动预装:

```sh
pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2
```

> PP-StructureV3 = PP-OCRv5 文字识别 + 版面分析 + 表格结构识别(SLANet++),
> 输出带结构的 Markdown(标题 `##`、段落、管道表格、公式 `$$`、印章注释)。

## 安装

### 作为 DSH 插件

```sh
dsh plugin --profile web add github:yakoylp/dsh-md-convert
```

安装后重启 `dsh web`,agent 获得 `md_convert` 工具。CLI 命令 `dsh-md-convert` 随 profile 的 `node_modules/.bin` 暴露。

### 独立命令行(不装进 DSH)

```sh
git clone https://github.com/yakoylp/dsh-md-convert.git
cd dsh-md-convert
npm install
npm link          # 全局获得 dsh-md-convert 命令
# 或直接调用
node lib/cli.js <文件...> -o <输出目录>
```

## 命令行用法

```sh
# 基本:批量转换
dsh-md-convert a.docx b.pdf -o ./md

# 老格式(自动探测 WPS→Office)
dsh-md-convert old.doc old.xls old.ppt -o ./md

# 强制指定老格式后端
dsh-md-convert old.doc -o ./md --legacy-backend wps

# 扫描件:自动走 PP-StructureV3(无需任何 OCR 参数;缺依赖自动安装)
dsh-md-convert scan.pdf -o ./md

# 指定 Python 解释器(多 Python 环境时)
dsh-md-convert scan.pdf -o ./md --ocr-python "C:\path\to\python.exe"

# 检查 / 安装 OCR 依赖
dsh-md-convert check        # 只检查状态,不安装
dsh-md-convert deps         # 检查并自动安装缺失依赖
```

完整选项见 `dsh-md-convert --help`。

## 错误码与退出码

失败时**必定携带稳定错误码**,调用方(CLI / agent / 二次开发)可据此分类处理:

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | 源文件不存在 | 检查路径 |
| `E_UNSUPPORTED_FORMAT` | 扩展名不受支持 | 更换格式 |
| `E_MARKITDOWN` | MarkItDown 转换失败 | 多为文件损坏/加密,可重试 |
| `E_LEGACY_CONVERT` | 老格式 COM 另存失败 | 需本机 WPS/Office;已内置自动重试 |
| `E_OCR_DEPS` | 缺 OCR 依赖(自动安装失败/已禁用) | 执行 `dsh-md-convert deps` |
| `E_OCR_RUN` | PP-StructureV3 执行失败 | 重试或降低 `--ocr-scale` |
| `E_OCR_EMPTY` | 扫描件未识别出内容 | 检查扫描质量 |
| `E_OUTPUT` | 输出写入失败 | 检查 outDir 权限/磁盘 |
| `E_UNKNOWN` | 其他错误 | 查看 error 消息 |

**CLI 输出格式**(批量时每行可定位到具体文件):

```
✓ markitdown  → ./md/a.md
✗ [E_OCR_EMPTY] 扫描件未识别出任何内容  C:\docs\扫描件.pdf
✗ [E_FILE_NOT_FOUND] 文件不存在:...  C:\docs\缺失.docx
```

**退出码**:`0` 全部成功 / `1` 存在失败(失败行含 `[错误码]` 与源文件路径)/ `2` 参数错误。

## Agent 工具

安装插件后,agent 可用 `md_convert` 工具:

```
md_convert({ file: "报告.docx", outDir: "./md" })
→ { ok: true, output: "./md/报告.md", chain: "markitdown", warnings: [] }
```

插件配置(`cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-md-convert
      name: dsh-md-convert
      config:
        outDir: ""            # 输出目录;空则用会话工作区
        forceOcr: false       # 强制 PDF 走 OCR
        ocrScale: 2           # PDF 渲染倍率
        autoInstallDeps: true # 缺 OCR 依赖时自动 pip 安装
        ocr:
          python: ""          # Python 解释器(运行 PP-StructureV3;空则自动探测)
        legacy:
          backend: "auto"     # auto | wps | office
```

## 老格式转换后端

`.doc/.xls/.ppt` 先另存为现代格式再交给 MarkItDown。后端自动探测顺序:**WPS → MS Office**;
均通过 COM(PowerShell 脚本)实现,转换期间若 Office/WPS 正在运行会自动重试(不会杀用户进程)。

## 临时文件清理

- 每次转换使用独立临时目录(`%TEMP%/dsh-md-convert-*`),结束即删除
- 进程异常退出时,`exit`/信号钩子兜底清理,下次运行自动清扫历史残留
- OCR 无中间文件(Python 侧内存完成);调试可用 `--keep-temp` 保留

## 测试

```sh
node test/run-smoke.mjs          # 7 种格式全链路(依赖本机 WPS/Office + PP-StructureV3)
```

## 已知问题

- **paddlepaddle ≥3.3 的 oneDNN 与 PIR 静态图不兼容**会导致推理崩溃,插件已自动禁用
  (`FLAGS_use_mkldnn=0` + `enable_mkldnn=False`),无需手动处理。
- 扫描件 OCR 质量取决于版面清晰度;复杂表格/公式页面建议更高 `--ocr-scale`(如 3)。

## 限制

- 加密/损坏文件、部分复杂版面可能转换失败(会给出明确错误)
- MarkItDown 不支持的格式(如 `.pages/.key` 等)会明确报"不支持"
- PP-StructureV3 首次运行会下载模型(约数百 MB 到 `~/.paddlex/`),之后秒级加载

## 许可证

[MIT](LICENSE) © 2026 YAKO

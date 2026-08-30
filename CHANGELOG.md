# Changelog

## [0.5.4] — 修复与健壮性强化

### 路径解析彻底修复（重要）

`md_convert` 工具对**相对路径**与 **Windows 绝对路径**的解析此前均有误，导致所有正常调用都报 `E_FILE_NOT_FOUND`，且错误路径被拼到 DSH 依赖目录下（如 `C:\…\dependencies\dsh\E:\办公室工作\…`）。现彻底修复：

- 相对路径基准从宿主进程 `process.cwd()` 改为**会话工作区** `exec.agent.session.header.cwd`（与官方 `dsh-tool-fs` / `dsh-tool-bash` 一致）——桌面部署下 `process.cwd()` 是 DSH 依赖目录、不是工作区。
- 绝对路径（含盘符 `E:\…`）改用 `path.resolve` 处理，原样保留、不再被拼接破坏。
- 输出目录 `outDir` 的默认值同样落到会话工作区。
- 新增 2 个回归测试：相对路径按 `session.cwd` 解析、绝对路径原样保留。

### 绝对路径不再被 join 破坏

- `md_convert` 工具层移除 `join(process.cwd(), file)`，直接透传并交由 `path.resolve` 处理，盘符绝对路径不再被拼成 `dsh\E:\…`。

### OCR 重活异步化，不再阻塞宿主事件循环

- 新增 `lib/core/spawn.js`（`runAsync`：Promise 化 spawn + 有界收集 stdout/stderr + 超时）。
- `pip install`（依赖安装）、模型下载、OCR 三处分钟级同步调用改为异步；插件运行于 DSH 宿主进程时，转换扫描件/装依赖不再冻结整个 web 服务。
- 快速探测（`python --version`、模块检测、模型缓存检测）保持同步，符合「仅异步化重活」的取舍。

### 扫描件缺模型时明确报错

- `viaOcr` 在执行 OCR 前先检查模型缓存；缺失时返回 `E_OCR_DEPS` + 明确指引「请先执行 `dsh-md-convert deps` 预下载模型」，不再带晦涩的 paddle 报错（模型下载本就只在 CLI 的 `deps` 阶段进行，不自动联网下载）。
- 同步修正 `README.agent.md` 把「装依赖」与「下载模型」混为一谈的措辞。

### 进程信号处理不再泄漏到宿主

- `SIGINT/SIGTERM` 的 `process.exit` 从模块惰性注册中拆出，改为显式 `installSignalCleanup()`，仅在 CLI 入口调用；插件运行于宿主时不再抢在宿主优雅停机（会话日志落盘、drain）之前退出。`exit` 钩子保留（仅清理临时目录，无害）。

### 临时目录并发安全

- 临时根目录名改为 `dsh-md-convert-<pid>-`，`sweepStale` 只清理 pid 已死的残留目录，不再误删并发运行中的其它进程/转换的中间文件。

### 描述 / 注释措辞修正

- 「PP-StructureV3」→「路由 OCR」（工具 description、错误码注释、CLI 注释、测试注释），与 v0.5.0 切换后的实际实现一致。

### 入参基础校验

- `md_convert` 的 `file` 非字符串时返回明确错误；`outDir` / `forceOcr` 做类型防御（raw 注册无内置参数校验）。

### Python 除零保护

- `routing_ocr.py` 两处 OCR 文本/表格循环加空结果保护，避免极端输入下 `sum/len` 除零。

---

### 涉及文件

- 新增：`lib/core/spawn.js`、`CHANGELOG.md`
- 修改：`lib/index.js`、`lib/core/convert.js`、`lib/core/deps.js`、`lib/core/ocr.js`、`lib/core/cleanup.js`、`lib/core/errors.js`、`lib/cli.js`、`lib/py/routing_ocr.py`、`README.agent.md`、`test/cordis-entry.test.mjs`、`test/run-smoke.mjs`

### 测试

- `npm test` 8/8 通过（含 2 个新增路径解析回归测试）。
- 7 文件冒烟全绿（含 WPS COM 老格式链路）。
- OCR 两分支人工验证通过：正常扫描件识别（表格/标题/正文）、缺模型时明确报错。

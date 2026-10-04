# Changelog

## [0.5.7] — 宿主内 MarkItDown 改由子进程执行

### 修掉「宿主内 Office/PDF 转换必失败」的根因

在 DSH 宿主进程内加载 `markitdown-node` 会抛:

```
TypeError: createRequire.resolve.paths is not a function or its return value is not iterable
```

根因不在本插件,而在宿主的插件依赖路由层:它把 `pkg/` 形式的 CJS 请求剥成包名后调用
`require.resolve.paths(包名)`;若剥出的名字正好是 Node 内置模块名,该调用返回 `null`,
随后的 `for...of` 抛 `TypeError`(`@deepseek-ai/dsh-app-boot` 的 `routeScoped`)。

触发链是固定的:`markitdown-node` 顶层 require `jsdom` → `whatwg-url` → `tr46`,
而 `tr46` 里有一句 `require("punycode/")`(带尾斜杠是社区惯例,用于取 npm 版 punycode
而非已废弃的内置模块)。斜杠被剥掉后名字成了内置模块名 `punycode`,于是必然命中。

因此**只要在宿主进程内加载 MarkItDown 就一定会失败**,与调用方式无关;独立 CLI 因没有该
路由层而一直正常。

### 变更

- **新增 `lib/core/markitdown.js`**:markitdown 访问层,默认 `worker` 模式;
  `in-process` 保留作诊断与无法 spawn 环境的逃生口
- **新增 `lib/core/markitdown-worker.mjs`**:子进程侧加载 MarkItDown,结果写入临时 JSON
  文件(不依赖 stdout,避免 markitdown/jsdom 的偶发输出污染结果)
- **`lib/core/convert.js`**:`viaMarkItDown` 改为委托访问层,三条链路
  (modern / 文字层 PDF / legacy → markitdown)全部走子进程
- **`lib/index.js`**:新增可选配置 `markitdown.mode | node | timeoutMs` 的透传与文档
- **`lib/cli.js` 行为不变**:CLI 输出格式、退出码、参数均未改动
- 子进程解释器默认 `process.execPath`;Electron 宿主自动追加 `ELECTRON_RUN_AS_NODE=1`,
  可用 `markitdown.node` 或 `DSH_MD_CONVERT_NODE` 覆盖
- 失败统一映射为既有错误码 `E_MARKITDOWN`(消息含退出码与 stderr 尾部),
  **不新增错误码**,公开错误码面保持不变
- 附带收益:jsdom/sharp 等重依赖的加载与内存开销移出长驻宿主进程

### 测试

- 新增 `test/markitdown-worker.test.mjs`(9 项):worker 协议与失败上报、两种模式端到端、
  解释器不可用与转换失败的 `E_MARKITDOWN` 映射、`convertFile` 默认走 worker
- `npm test` 18/18 通过(含既有清理、cordis 入口、legacy 后端测试)
- `node test/run-smoke.mjs` 7/7 通过(新链路含 `legacy(wps) → markitdown` 与 PDF 文字层)

### 说明

同源缺陷会影响**任何**依赖树里含 jsdom(→ whatwg-url → tr46)的插件,建议向 DSH 侧反馈;
若宿主修复(例如在内置名判断上放行,或对 `resolve.paths()` 返回 `null` 做空数组兜底),
本插件可切回 `mode: "in-process"`。

---

## [0.5.6] — 清扫逻辑误删用户目录修复

### `sweepStale()` 不再删除非插件拥有的目录

旧实现把 tmpdir 下所有以 `dsh-md-convert-` 开头、但不含 `<pid>-` 格式的目录一律当作旧版残留删除——包括**用户自建的、恰好共用前缀的目录**(实测:名为 `dsh-md-convert-call-test` 的目录在转换时被误删)。一个运行于宿主进程的工具随意删除未知目录是安全隐患。

- 旧版(无 pid)目录现在只清理符合 **mkdtemp 格式**(`dsh-md-convert-<6位字母数字>`)的残留;
- 其它同名前缀目录一律保留;
- pid 格式目录行为不变(pid 已死才清理)。
- 新增回归测试:旧版 mkdtemp 残留被删、用户目录保留、死 pid 残留被删。

### 测试

- `npm test` 10/10 通过(含新增清扫回归)。

---

## [0.5.5] — 工具返回值校验修复

### `chain` 字段类型不匹配(工具结果被框架拦截)

`output.schema` 把 `chain` 声明为数组(`{ type: "array", items: { type: "string" } }`),而 `convert.js` 实际返回的是**字符串**(如 `"legacy(wps) → markitdown"`、`"路由OCR"`)。转换成功后,DSH 框架按 schema 校验返回值,报 `"value.chain" must be an array`,工具结果传不回对话。

- schema 改为 `chain: { type: "string" }`,与 `convert.js` / `cli.js` / README 示例(字符串写法)一致。
- 渲染回调去掉 `.length` / `.join(" → ")`,直接拼接字符串。
- 新增回归测试:校验 `execute()` 的返回值(成功/失败两种形状)必须通过声明的 output schema——schema 与返回值不一致会在测试里直接红,而不是在 DSH 运行时报 `"value.chain" must be an array`。

### 测试

- `npm test` 9/9 通过(含新增返回值校验回归)。

---

## [0.5.4] — 修复与健壮性强化

### 路径解析彻底修复（重要）

`md_convert` 工具对**相对路径**与 **Windows 绝对路径**的解析此前均有误，导致所有正常调用都报 `E_FILE_NOT_FOUND`，且错误路径被拼到 DSH 依赖目录下（如 `C:\…\dependencies\dsh\E:\<工作目录>\…`）。现彻底修复：

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

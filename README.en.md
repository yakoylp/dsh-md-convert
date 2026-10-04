# dsh-md-convert

[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

Convert Office documents and PDFs (including scanned ones) to Markdown with **structurally preserved formatting**, powered by [MarkItDown](https://github.com/microsoft/markitdown). Ships both a **CLI** and a **dsh agent tool** (`md_convert`).

- **AI Agent usage guide**: [README.agent.md](README.agent.md) (error-code handling / batch rules / call conventions)
- 中文说明(Chinese): [README.md](README.md)

## Supported formats & conversion pipelines

| Input | Pipeline | Notes |
| --- | --- | --- |
| `.docx` / `.xlsx` / `.pptx` | MarkItDown direct | Headings/lists/tables/paragraphs kept as Markdown |
| `.pdf` (with text layer) | MarkItDown direct | Falls back to **routing OCR** automatically when the text layer is empty |
| `.pdf` (scanned) | **Routing OCR** (PP-DocLayout-L layout + RapidOCR text / SLANet tables / FormulaNet formulas) | Headings/body/tables/formulas/stamps, CPU-only, lightweight models |
| `.doc` / `.xls` / `.ppt` | WPS/Office COM (Windows) or LibreOffice (other platforms) re-save to modern format → MarkItDown | Backend auto-detected, configurable |
| `.html/.csv/.json/.xml/.ipynb/.md/.txt/...` | MarkItDown / direct read | Everything MarkItDown supports |

> **"Structural formatting"** = heading levels (H1–H6), lists, tables (pipe tables), paragraph order are preserved.
> Markdown cannot express visual details (fonts/sizes/colors/indentation); no converter preserves them — that is inherent to the format.

## Environment & dependencies

- **Node.js ≥ 18**
- Legacy formats (`.doc/.xls/.ppt`): on **Windows** require **WPS Office** or **Microsoft Office** (COM auto-detected); on **Linux/macOS** require **LibreOffice** (`apt install libreoffice`; auto-detects `soffice`)
- **Scanned-PDF OCR is CPU-first, lightweight-model-first, cost/performance-oriented**: a modular routing pipeline — `PP-DocLayout-L` layout analysis (lightweight) routes each region: **text → RapidOCR (PP-OCRv6 ONNX, fastest)**, tables → SLANet + RT-DETR, **formulas → FormulaNet-Plus-S (lightweight)**; heading levels come from the layout model. Quality is reasonably guaranteed, but speed takes priority (complex layouts / tiny text may be incomplete)
- On headless Linux servers install CJK fonts (`fonts-noto-cjk`)
- **Local models**: OCR models are downloaded once to the local cache (`~/.paddlex/official_models/`, a few hundred MB) via `dsh-md-convert deps`; **after that, runs are fully offline** — no network checks, OCR works without internet

**Auto-install of dependencies (default on)**: on first scanned-PDF conversion the plugin
detects Python and the OCR packages (`paddlepaddle` `paddleocr` `paddlex[ocr]` `pypdfium2` `rapidocr` `onnxruntime`);
if present it uses them, if missing it runs `pip install` automatically. Disable with
`--no-auto-install-deps`, or pre-install manually:

```sh
pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2 rapidocr onnxruntime
```

> Routing OCR = PP-DocLayout-L layout (threshold 0.3) + region routing: text→RapidOCR,
> tables→SLANet structure + RT-DETR cells + OCR fill, formulas→FormulaNet-S, stamps→comments.

## Installation

### As a DSH plugin

```sh
dsh plugin --profile web add github:yakoylp/dsh-md-convert
```

After installing, restart `dsh web`; the agent gains the `md_convert` tool. The `dsh-md-convert` CLI command is exposed via the profile's `node_modules/.bin`.

### Standalone CLI (without DSH)

```sh
git clone https://github.com/yakoylp/dsh-md-convert.git
cd dsh-md-convert
npm install
npm link          # global dsh-md-convert command
# or run directly
node lib/cli.js <files...> -o <output-dir>
```

## CLI usage

```sh
# Basic: batch convert
dsh-md-convert a.docx b.pdf -o ./md

# Legacy formats (auto: WPS→Office on Windows, LibreOffice on Linux/macOS)
dsh-md-convert old.doc old.xls old.ppt -o ./md

# Force a specific legacy backend
dsh-md-convert old.doc -o ./md --legacy-backend wps

# Scanned PDF: automatic routing OCR (deps auto-installed if missing)
dsh-md-convert scan.pdf -o ./md

# Pin a Python interpreter (multi-Python setups)
dsh-md-convert scan.pdf -o ./md --ocr-python "C:\path\to\python.exe"

# Check / install OCR deps and models
dsh-md-convert check        # status only, no install
dsh-md-convert deps         # install missing deps and pre-download OCR models (one network run; offline afterwards)
```

Full options: `dsh-md-convert --help`.

## Error codes & exit codes

Every failure carries a **stable error code** so callers (CLI / agent tool / SDK) can classify it:

| Code | Meaning | Handling |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | Source file missing | Check the path |
| `E_UNSUPPORTED_FORMAT` | Extension not supported | Use another format |
| `E_MARKITDOWN` | MarkItDown conversion failed | Usually corrupt/encrypted file; retry once |
| `E_LEGACY_CONVERT` | Legacy re-save failed (COM/LibreOffice) | WPS/Office on Windows, LibreOffice elsewhere; built-in retry on busy |
| `E_OCR_DEPS` | OCR deps missing (install failed/disabled) | Run `dsh-md-convert deps` |
| `E_OCR_RUN` | Routing OCR execution failed | Retry, or lower `--ocr-scale` |
| `E_OCR_EMPTY` | Scanned page yielded no text | Check scan quality |
| `E_OUTPUT` | Output write failed | Check outDir permission/disk |
| `E_UNKNOWN` | Any other error | Read the error message |

**CLI output format** (each failed line names the exact file):

```
✓ markitdown  → ./md/a.md
✗ [E_OCR_EMPTY] No text recognized in scanned page  C:\docs\scan.pdf
✗ [E_FILE_NOT_FOUND] File not found:...  C:\docs\missing.docx
```

**Exit codes**: `0` all ok / `1` some failed (lines carry `[CODE]` + source path) / `2` usage error.

## Agent tool

After installing the plugin, agents can use the `md_convert` tool:

```
md_convert({ file: "report.docx", outDir: "./md" })
→ { ok: true, output: "./md/report.md", chain: "markitdown", warnings: [] }
```

Plugin config (`cordis.patch.yml`):

```yaml
- insert:
    - id: dsh-md-convert
      name: dsh-md-convert
      config:
        outDir: ""            # output dir; empty = session workspace
        forceOcr: false       # force OCR for PDFs
        ocrScale: 2           # PDF render scale
        autoInstallDeps: true # auto pip-install missing OCR deps
        ocr:
          python: ""          # Python interpreter (empty = auto-detect)
        legacy:
          backend: "auto"     # auto | wps | office | libreoffice (auto: COM on Windows, LibreOffice elsewhere)
        markitdown:
          mode: "worker"      # worker (default, subprocess) | in-process (diagnostics only; fails inside a DSH host)
          node: ""            # interpreter for the worker; empty = auto-detect
          timeoutMs: 0        # worker timeout in ms; 0 = no timeout
```

## How MarkItDown runs (subprocess by default)

`.docx/.xlsx/.pptx` and text-layer PDFs are converted by MarkItDown, and that step **runs in a
subprocess by default**:

- The child is launched with `process.execPath`; inside an Electron host (the official desktop app)
  `ELECTRON_RUN_AS_NODE=1` is added so the same binary runs the worker as plain Node
- Pin an interpreter with `markitdown.node` or the `DSH_MD_CONVERT_NODE` environment variable
- The worker writes its result to a temp JSON file that the parent reads, so stray stdout from
  markitdown/jsdom cannot corrupt the result; every failure maps to `E_MARKITDOWN` (message carries
  the exit code and the stderr tail)

**Why a subprocess**: the DSH host installs a plugin dependency-routing layer for profile modules. It
strips `pkg/`-style requests down to the package name and then calls `require.resolve.paths(name)`;
when the stripped name happens to be a Node built-in, that call returns `null` and the following
`for...of` throws a `TypeError`. MarkItDown depends on jsdom at the top level, and the chain
jsdom → whatwg-url → tr46 contains `require("punycode/")` (used deliberately to get the npm
punycode package rather than the deprecated built-in), which hits exactly that defect — so loading
MarkItDown **inside the host process always fails**. A separate process has no such routing layer and
resolves normally. Side benefit: jsdom/sharp and their memory cost no longer live in the long-running
host process.

`mode: "in-process"` remains as a diagnostic escape hatch, and for environments where spawning is
impossible; inside a DSH 0.2.0-rc.2 host it still fails, so do not use it to work around the defect.

## Legacy format backends

`.doc/.xls/.ppt` are re-saved to modern formats before MarkItDown. The backend is chosen per platform:

| Platform | auto backend | Implementation |
| --- | --- | --- |
| Windows | **WPS → MS Office** | COM (PowerShell scripts); auto-retries when Office/WPS is busy (never kills user processes) |
| Linux / macOS | **LibreOffice** | `soffice --headless --convert-to`; requires LibreOffice (auto-detects `soffice`/`libreoffice`) |

Use `--legacy-backend wps | office | libreoffice` to force a specific backend (e.g. Windows without WPS/Office but with LibreOffice installed: `--legacy-backend libreoffice`).

## Temp-file cleanup

- Each conversion uses a dedicated temp dir (`%TEMP%/dsh-md-convert-*`), removed when done
- On abnormal exit, `exit`/signal hooks clean up; the next run sweeps any leftovers
- OCR produces no intermediate files (done in Python memory); use `--keep-temp` for debugging

## Tests

```sh
npm test                       # unit tests (backend split, LibreOffice mock)
node test/run-smoke.mjs        # smoke across 7 formats (Windows: WPS/Office; Linux: LibreOffice)
node test/run-smoke.mjs --all --reference   # all 8 formats (incl. scanned OCR) and write reference outputs to test/fixtures/final-out/
```

## Known issues

- **paddlepaddle ≥3.3 has a oneDNN/PIR static-graph incompatibility** that crashes inference; the plugin
  disables it automatically (`FLAGS_use_mkldnn=0` + `enable_mkldnn=False`), no manual action needed.
- **DSH host routing defect (affects dsh 0.2.0-rc.2)**: when resolving a `pkg/` request from a profile
  module, the host strips it to the package name and calls `require.resolve.paths()`; if that name is a
  Node built-in (e.g. `require("punycode/")` → `punycode`) the call returns `null` and a `TypeError` is
  thrown. This plugin sidesteps it by running MarkItDown in a subprocess (see above). The same defect
  affects **any** plugin whose dependency tree contains jsdom (→ whatwg-url → tr46) and is worth
  reporting upstream.
- Scanned-PDF OCR quality depends on page clarity; for complex layouts / tiny text raise `--ocr-scale` (e.g. 3) — accuracy improves, time increases.

## Limitations

- Corrupt/encrypted files and some complex layouts may fail (with a clear error)
- Formats MarkItDown does not support (e.g. `.pages/.key`) are reported explicitly as unsupported
- **Speed-first trade-offs**: routing OCR uses lightweight models (layout PP-DocLayout-L, text RapidOCR, formula FormulaNet-S); quality is reasonably guaranteed, but complex tables (multi-level merges / slanted headers), complex multi-column layouts, and very small fonts may be incomplete
- OCR models need a one-time network download (a few hundred MB to `~/.paddlex/`); afterwards fully offline, fast loads

## License

[MIT](LICENSE) © 2026 yakoylp

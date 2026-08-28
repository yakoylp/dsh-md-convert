# dsh-md-convert

[![License: MIT](https://img.shields.io/badge/license-MIT-4D6BFE)](LICENSE)

Convert Office documents and PDFs (including scanned ones) to Markdown with **structurally preserved formatting**, powered by [MarkItDown](https://github.com/microsoft/markitdown). Ships both a **CLI** and a **dsh agent tool** (`md_convert`).

- **AI Agent usage guide**: [README.agent.md](README.agent.md) (error-code handling / batch rules / call conventions)
- 中文说明(Chinese): [README.md](README.md)

## Supported formats & conversion pipelines

| Input | Pipeline | Notes |
| --- | --- | --- |
| `.docx` / `.xlsx` / `.pptx` | MarkItDown direct | Headings/lists/tables/paragraphs kept as Markdown |
| `.pdf` (with text layer) | MarkItDown direct | Falls back to **PP-StructureV3** automatically when the text layer is empty |
| `.pdf` (scanned) | **PP-StructureV3** (layout analysis + OCR) → Markdown | Headings/body/tables/formulas/stamps assembled in reading order, CPU-only |
| `.doc` / `.xls` / `.ppt` | WPS/Office COM (Windows) or LibreOffice (other platforms) re-save to modern format → MarkItDown | Backend auto-detected, configurable |
| `.html/.csv/.json/.xml/.ipynb/.md/.txt/...` | MarkItDown / direct read | Everything MarkItDown supports |

> **"Structural formatting"** = heading levels (H1–H6), lists, tables (pipe tables), paragraph order are preserved.
> Markdown cannot express visual details (fonts/sizes/colors/indentation); no converter preserves them — that is inherent to the format.

## Environment & dependencies

- **Node.js ≥ 18**
- Legacy formats (`.doc/.xls/.ppt`): on **Windows** require **WPS Office** or **Microsoft Office** (COM auto-detected); on **Linux/macOS** require **LibreOffice** (`apt install libreoffice`; auto-detects `soffice`)
- Scanned-PDF OCR always uses Baidu **PP-StructureV3** (CPU-only, no GPU needed); on headless Linux servers install CJK fonts (`fonts-noto-cjk`)
- **Default pipeline**: document orientation correction / layout analysis / table recognition / text OCR; formula, seal and chart recognition are **off by default** — enable with `--ocr-formula` / `--ocr-seal` / `--ocr-chart` (pre-download models first: `dsh-md-convert deps --ocr-formula`)
- **Local models**: OCR models are downloaded once to the local cache (`~/.paddlex/official_models/`, a few hundred MB) via `dsh-md-convert deps`; **after that, runs are fully offline** — no network checks, OCR works without internet

**Auto-install of dependencies (default on)**: on first scanned-PDF conversion the plugin
detects Python and the OCR packages (`paddlepaddle` `paddleocr` `paddlex[ocr]` `pypdfium2`);
if present it uses them, if missing it runs `pip install` automatically. Disable with
`--no-auto-install-deps`, or pre-install manually:

```sh
pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2
```

> PP-StructureV3 = PP-OCRv5 text recognition + layout analysis + table structure recognition (SLANet++),
> producing structured Markdown (`##` headings, paragraphs, pipe tables, `$$` formulas, stamp comments).

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

# Scanned PDF: automatic PP-StructureV3 (deps auto-installed if missing)
dsh-md-convert scan.pdf -o ./md

# Pin a Python interpreter (multi-Python setups)
dsh-md-convert scan.pdf -o ./md --ocr-python "C:\path\to\python.exe"

# Optional OCR modules (off by default; pre-download models first: dsh-md-convert deps --ocr-formula)
dsh-md-convert formula-doc.pdf -o ./md --ocr-formula   # formula recognition
dsh-md-convert doc.pdf -o ./md --ocr-seal              # seal recognition
dsh-md-convert chart-doc.pdf -o ./md --ocr-chart       # chart recognition

# Fast mode (PP-OCRv5 mobile models, ~40% faster, slightly lower accuracy; pre-download: dsh-md-convert deps --ocr-fast)
dsh-md-convert scan.pdf -o ./md --ocr-fast

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
| `E_OCR_RUN` | PP-StructureV3 execution failed | Retry, or lower `--ocr-scale` |
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
          formula: false      # enable formula recognition (default off; pre-download: dsh-md-convert deps --ocr-formula)
          seal: false         # enable seal recognition (default off)
          chart: false        # enable chart recognition (default off)
          fast: false         # fast mode: PP-OCRv5 mobile models (~40% faster, slightly lower accuracy)
        legacy:
          backend: "auto"     # auto | wps | office | libreoffice (auto: COM on Windows, LibreOffice elsewhere)
```

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
- Scanned-PDF OCR quality depends on page clarity; for complex table/formula pages use a higher `--ocr-scale` (e.g. 3).

## Limitations

- Corrupt/encrypted files and some complex layouts may fail (with a clear error)
- Formats MarkItDown does not support (e.g. `.pages/.key`) are reported explicitly as unsupported
- PP-StructureV3 downloads its models on first run (a few hundred MB to `~/.paddlex/`); later loads are fast

## License

[MIT](LICENSE) © 2026 yakoylp

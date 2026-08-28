# dsh-md-convert — AI Agent Usage Guide (Agent-Oriented README)

> This document is written for **AI agents (models)**. It defines how to use the
> `md_convert` tool: when to use it, how to call it, how to handle errors, and
> batch-conversion conventions. Human users should read [README.en.md](README.en.md) / [README.md](README.md).

---

## 1. What this tool is

`md_convert` converts Office / PDF documents into Markdown with **structurally preserved formatting**:

| Input | Pipeline | Output structure |
| --- | --- | --- |
| `.docx` / `.xlsx` / `.pptx` | MarkItDown direct | headings / lists / pipe tables / paragraphs |
| `.pdf` (has text layer) | MarkItDown direct | same as above |
| `.pdf` (scanned / empty text layer) | PP-StructureV3 (layout analysis + OCR) | `##` headings / paragraphs / tables / formulas / stamp comments, in reading order |
| `.doc` / `.xls` / `.ppt` | WPS/Office COM re-save → MarkItDown | same as above |
| `.html/.csv/.json/.xml/.ipynb/.md/.txt` | MarkItDown / direct read | format-dependent |

**Core capability**: scanned PDFs also produce structured Markdown (headings/tables), CPU-only.

## 2. When to use (decision rules)

**Use `md_convert` when:**
- The user asks to "convert documents to .md / extract document content as Markdown / batch-convert files"
- The source is a scanned PDF that needs structural recognition (headings, tables, paragraphs)
- Multiple Office/PDF documents must be normalized into Markdown for downstream work (search, merge, diff)

**Do NOT use it; prefer other tools when:**
- You only need to **read** document content into context (no .md file on disk) → use `docx_read` / `pdf_read` / `xlsx_read` / `pptx_read` (dsh-office)
- You only need to **generate** new documents → use `docx_create` / `pdf_create` / `xlsx_write` / `pptx_create`
- Visual fidelity matters (fonts/sizes/colors/indentation) → no converter preserves these; Markdown cannot express them. Tell the user.

## 3. Call conventions

```jsonc
// Single file
md_convert({ "file": "contract.pdf", "outDir": "./md" })
// → { ok: true, output: "./md/contract.md", chain: "markitdown(empty) → PP-StructureV3", warnings: [] }

// Force the scanned path
md_convert({ "file": "scan.pdf", "forceOcr": true, "outDir": "./md" })
```

**Parameter conventions:**
- `file`: absolute path, or a path relative to the current workspace
- `outDir`: output directory (optional); defaults to the session workspace. **Recommend passing an explicit separate directory** (e.g. `./md`) so outputs don't mix with sources
- Output filename = source basename (without extension) + `.md`; same-name files are overwritten by default
- `forceOcr`: default `false`. PDFs are auto-detected — empty text layer falls back to PP-StructureV3 automatically, so this is rarely needed

**Return shape:**
- Success: `{ ok: true, output, chain, warnings? }`
  - `chain`: actual pipeline, e.g. `"markitdown"` / `"legacy(wps) → markitdown"` / `"PP-StructureV3"`
  - `warnings`: non-fatal notices (e.g. a page yielded nothing)
- Failure: `{ ok: false, code, file, error }` — `code` is a **stable error code**, see below

## 4. Error codes & handling (important)

On failure the tool **always** returns a stable error code; classify by code:

| Code | Meaning | Agent handling |
| --- | --- | --- |
| `E_FILE_NOT_FOUND` | Source file missing | Verify the path/filename, confirm with the user, then retry |
| `E_UNSUPPORTED_FORMAT` | Extension not supported (e.g. `.pages/.key/.mp4`) | Tell the user; if content is text, suggest renaming or pre-converting |
| `E_MARKITDOWN` | MarkItDown conversion failed | Usually corrupt/encrypted/abnormal structure. Retry once; if it persists, tell the user the file may be damaged |
| `E_LEGACY_CONVERT` | Legacy (doc/xls/ppt) COM re-save failed | WPS/Office must be installed; retries automatically when Office is busy; if it persists, inform the user |
| `E_OCR_DEPS` | OCR deps missing (auto-install failed or disabled) | Auto-install usually handles it; otherwise tell the user to run `dsh-md-convert deps` |
| `E_OCR_RUN` | PP-StructureV3 execution failed | Retry; if persistent, suggest lowering `ocrScale` |
| `E_OCR_EMPTY` | Scanned page yielded no text | Tell the user the page is too dark / mis-oriented / low quality; suggest rescanning |
| `E_OUTPUT` | Output dir/file write failed | Check outDir permissions and disk space |
| `E_UNKNOWN` | Any other unexpected error | Report the `error` message verbatim |

**Fixed actions on failure:**
1. When reporting, **always include `code` and `file`**, e.g.: `[E_OCR_EMPTY] Page 2 yielded no text — C:\docs\scan.pdf`
2. For `E_OCR_RUN` / `E_MARKITDOWN` you may auto-retry once (a few seconds apart)
3. For `E_FILE_NOT_FOUND` / `E_UNSUPPORTED_FORMAT` do NOT retry — confirm with the user directly

## 5. Batch-conversion conventions

- One `md_convert` call handles **one file**; for batches, **loop calls** and collect each result separately
- Each result is independent: `{ ok, file, output?, code?, error? }` — locate failures by `file`, never rely on order
- Batch strategy:
  - Convert all, collect `ok: false` results, then report the failure list to the user in one place (`[code] file: error`)
  - For successes, report output paths only; do NOT paste full outputs back into the conversation (long docs waste context) unless asked
- Use the same `outDir` for a batch; on filename collisions the later write overwrites — **confirm with the user first** or use separate directories

## 6. Post-conversion verification (recommended)

- Spot-check: `read` key parts of the output to confirm structure (headings/tables) and content completeness
- If quality issues are found (broken tables, missing pages), report them and suggest `--ocr-scale 3` for higher fidelity
- Do not re-read repeatedly to "finish" a file — read what you need

## 7. Dependencies & first use

- Scanned-PDF OCR deps: Python + `paddlepaddle` `paddleocr` `paddlex[ocr]` `pypdfium2`
- **Auto-detect on first use**: the plugin runs `pip install` automatically when deps are missing (configurable off) — no manual steps
- First PP-StructureV3 run downloads models (a few hundred MB to `~/.paddlex/`), which takes a while; later loads are fast
- For multi-Python environments, pin the interpreter via `ocr.python` config

## 8. Boundaries & notes

- **Structural, not visual**: fonts/sizes/colors/indentation are NOT preserved (inherent to Markdown) — tell the user proactively
- Scanned OCR quality depends on clarity; complex table/formula pages may mis-recognize
- Conversion is **read-only on the source**: source files are never modified; intermediate files are auto-cleaned
- Temp dirs (`%TEMP%/dsh-md-convert-*`) are cleaned automatically, with sweep-on-next-run even after a crash

---

*This guide is maintained with the plugin; error-code definitions live in `lib/core/errors.js`; behavior follows the code.*

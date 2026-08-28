# -*- coding: utf-8 -*-
"""
dsh-md-convert — PP-StructureV3 OCR 封装

输入:PDF 或图片路径
输出:JSON 到 stdout(或 --out 指定文件):
  {
    "ok": true,
    "pages": [
      { "index": 1, "blocks": [
          { "label": "paragraph_title", "content": "...", "order_index": 1, "bbox": [...] },
          ...
      ]}
    ],
    "warning": "..."
  }

依赖(一次性安装,CPU 即可):
  pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2

已知坑(已验证,2025-08):
  - paddlepaddle 3.3.x 的 oneDNN 与 PIR 静态图不兼容(ConvertPirAttribute2RuntimeAttribute),
    必须 FLAGS_use_mkldnn=0 + enable_mkldnn=False
  - paddleocr 3.7.0 的 PPStructureV3 结果 res.blocks 组装为空(疑似版本 bug),
    改为直接读 parsing_res_list(LayoutBlock: label/content/order_index/bbox)
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("FLAGS_use_mkldnn", "0")  # 规避 paddle 3.3 oneDNN bug


def render_pdf(pdf_path, scale=2.0):
    """pypdfium2 渲染 PDF 为 RGB 图片数组"""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    pages = []
    for i in range(len(pdf)):
        bitmap = pdf[i].render(scale=scale)
        pil = bitmap.to_pil()
        if pil.mode != "RGB":
            pil = pil.convert("RGB")
        pages.append(pil)
    return pages


def html_table_to_markdown(html):
    """表格 HTML → Markdown 管道表格(简单解析)"""
    html = html.replace("<html><body>", "").replace("</body></html>", "")
    rows = re.findall(r"<tr>(.*?)</tr>", html, re.S)
    md_rows = []
    for row in rows:
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in cells]
        md_rows.append(cells)
    if not md_rows:
        return ""
    ncols = max(len(r) for r in md_rows)
    md_rows = [r + [""] * (ncols - len(r)) for r in md_rows]
    lines = ["| " + " | ".join(md_rows[0]) + " |", "| " + " | ".join(["---"] * ncols) + " |"]
    for r in md_rows[1:]:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)


def run_ppstructure(image, engine):
    """对单张图片跑 PP-StructureV3,返回块列表(table 的 content 转为管道表格)"""
    result = engine.predict(input=image)
    blocks = []
    for item in result:
        for b in item.get("parsing_res_list", []):
            label = getattr(b, "label", "") or ""
            content = getattr(b, "content", "") or ""
            if label in ("table", "table_title") and content.lstrip().startswith("<"):
                content = html_table_to_markdown(content)
            blocks.append({
                "label": label,
                "content": content,
                "order_index": getattr(b, "order_index", 0) or 0,
                "index": getattr(b, "index", 0) or 0,
                "bbox": getattr(b, "bbox", None),
            })
    blocks.sort(key=lambda x: (x["order_index"], x["index"]))
    return blocks


def main():
    src = sys.argv[1]
    out_path = None
    scale = 2.0
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--out" and i + 1 < len(args):
            out_path = args[i + 1]
            i += 2
        elif args[i] == "--scale" and i + 1 < len(args):
            scale = float(args[i + 1])
            i += 2
        else:
            i += 1

    try:
        from paddleocr import PPStructureV3
    except ImportError:
        msg = ("未安装 paddleocr。请先执行: "
               "pip install paddlepaddle paddleocr \"paddlex[ocr]\" pypdfium2")
        print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
        return 1

    ext = Path(src).suffix.lower()
    engine = PPStructureV3(
        lang="ch",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        enable_mkldnn=False,
    )

    pages_result = []
    warning = None
    tmpdir = None
    try:
        if ext == ".pdf":
            images = render_pdf(src, scale=scale)
            if not images:
                print(json.dumps({"ok": False, "error": "PDF 渲染失败:无页面"}, ensure_ascii=False))
                return 1
        else:
            from PIL import Image
            images = [Image.open(src).convert("RGB")]

        # PaddleX 对 PIL 对象支持不可靠,保存为临时 PNG 再传文件路径
        tmpdir = tempfile.mkdtemp(prefix="dsh-ppstructure-")
        for idx, img in enumerate(images, 1):
            img_path = os.path.join(tmpdir, f"page-{idx:04d}.png")
            img.save(img_path)
            try:
                blocks = run_ppstructure(img_path, engine)
            except Exception as e:  # noqa: BLE001
                warning = f"第 {idx} 页 PP-StructureV3 失败:{e}"
                blocks = []
            pages_result.append({"index": idx, "blocks": blocks})
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False))
        return 1
    finally:
        if tmpdir and os.path.isdir(tmpdir):
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    payload = {"ok": True, "pages": pages_result}
    if warning:
        payload["warning"] = warning
    text = json.dumps(payload, ensure_ascii=False)
    if out_path:
        Path(out_path).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())

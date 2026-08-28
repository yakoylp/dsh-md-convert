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

模型(安装时下载到本地 ~/.paddlex/official_models/,之后完全离线运行):
  运行 `dsh-md-convert deps` 联网预下载;模型缓存齐全后本脚本不再做任何
  网络检查(设置了 PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=true),断网可用。

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

# 离线优先:跳过 PaddleX 对模型托管源的连通性检查(模型已本地缓存时零网络)。
# 模型缺失时 paddlex 仍会尝试下载(此时需要网络);预下载请用 `dsh-md-convert deps`。
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "true")

os.environ.setdefault("FLAGS_use_mkldnn", "0")  # 规避 paddle 3.3 oneDNN bug

# 渲染/输入图片的最大边长(像素)。超出按比例缩小——PP-OCRv5 在 ~72-144dpi 精度足够,
# 大图(A3 扫描件 scale=2 可达 2382px)直接送入检测器会让 CPU 推理慢一个量级。
MAX_SIDE = 1600


def _cap_max_side(pil):
    """将图片最长边限制为 MAX_SIDE,等比缩放;未超限则原样返回"""
    w, h = pil.size
    longest = max(w, h)
    if longest <= MAX_SIDE:
        return pil
    ratio = MAX_SIDE / float(longest)
    from PIL import Image

    return pil.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)


def render_pdf(pdf_path, scale=2.0):
    """pypdfium2 渲染 PDF 为 RGB 图片数组(超出 MAX_SIDE 自动缩小)"""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(str(pdf_path))
    pages = []
    for i in range(len(pdf)):
        bitmap = pdf[i].render(scale=scale)
        pil = bitmap.to_pil()
        if pil.mode != "RGB":
            pil = pil.convert("RGB")
        pages.append(_cap_max_side(pil))
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
    # 可选模块开关(默认关):--ocr-formula 公式识别 / --ocr-seal 印章识别 / --ocr-chart 图表识别
    use_formula = False
    use_seal = False
    use_chart = False
    # --ocr-fast:用 PP-OCRv5 mobile 检测/识别模型(更快,精度略降)
    use_fast = False
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--out" and i + 1 < len(args):
            out_path = args[i + 1]
            i += 2
        elif args[i] == "--scale" and i + 1 < len(args):
            scale = float(args[i + 1])
            i += 2
        elif args[i] == "--ocr-formula":
            use_formula = True
            i += 1
        elif args[i] == "--ocr-seal":
            use_seal = True
            i += 1
        elif args[i] == "--ocr-chart":
            use_chart = True
            i += 1
        elif args[i] == "--ocr-fast":
            use_fast = True
            i += 1
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
    # 默认管线:版面分析 + server 版 OCR + 表格识别,并开启文档方向分类/矫正/文本行方向
    # (扫描件歪斜/旋转时自动修正,开销极小)。公式/印章/图表识别默认关闭(公式模型 701MB、
    # 印章/图表检测在 CPU 上慢,普通扫描件用不到),可用 --ocr-formula/--ocr-seal/--ocr-chart 开启。
    engine = PPStructureV3(
        lang="ch",
        use_doc_orientation_classify=True,
        use_doc_unwarping=True,
        use_textline_orientation=True,
        use_formula_recognition=use_formula,
        use_seal_recognition=use_seal,
        use_chart_recognition=use_chart,
        text_detection_model_name="PP-OCRv5_mobile_det" if use_fast else None,
        text_recognition_model_name="PP-OCRv5_mobile_rec" if use_fast else None,
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
            images = [_cap_max_side(Image.open(src).convert("RGB"))]

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

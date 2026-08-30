# -*- coding: utf-8 -*-
"""
dsh-md-convert — 模块化 OCR 路由流水线(替换旧 PP-StructureV3 整体管线)

流程(全部本地 CPU,轻量模型优先,性价比优先):
  1. pypdfium2 渲染 PDF 每页(scale 可调,最长边限 1600px)
  2. PP-DocLayout-L 版面分析(阈值 0.3)→ 区域(标签 + 坐标)
  3. 按区域路由:
     - 文字(title/text/abstract/content/reference/...) → RapidOCR
       (自适应 padding + 越界钳制 + 按原区域过滤文本行; 标题层级由版面标签决定)
     - 表格 → TableClassification(有线/无线) + SLANet 结构 + RT-DETR 单元格
       定位 + 整表 RapidOCR 行按中点填格 → 管道表格
       (单列表格 = 文本框 → 递归内部版面分析, 标题由版面模型定)
     - 公式 → FormulaRecognition(PP-FormulaNet_plus-S) → $$ LaTeX $$
     - 印章 → 注释标记
  4. 每页拼装 Markdown, 输出 JSON {ok, md, warnings} 到 stdout

依赖(一次性安装,CPU 即可):
  pip install paddlepaddle paddleocr "paddlex[ocr]" pypdfium2 rapidocr onnxruntime

模型(安装时联网预下载到 ~/.paddlex/official_models/, 之后完全离线):
  PP-DocLayout-L / PP-LCNet_x1_0_table_cls / SLANeXt_wired / SLANet_plus /
  RT-DETR-L_wired_table_cell_det / RT-DETR-L_wireless_table_cell_det /
  PP-FormulaNet_plus-S
  RapidOCR 模型随包自带(PP-OCRv6 ONNX), 零下载。
  运行 `dsh-md-convert deps` 预下载; 缓存齐全后零网络(离线模式)。
"""
import json
import os
import sys
import time

os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "true")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "false")

import numpy as np
import pypdfium2 as pdfium

# 渲染/输入图片最大边长(像素): PP-OCRv5/RapidOCR 在 ~72-144dpi 精度足够,
# 大图直接送入检测器会让 CPU 推理慢一个量级。
MAX_SIDE = 1600
LAYOUT_THRESHOLD = 0.3

# 路由表: 版面标签 → 路由
ROUTE_TITLE = {"paragraph_title", "doc_title", "table_title", "chart_title"}  # 标题 → ##
ROUTE_TEXT = {"text", "abstract", "content", "reference", "footnote", "aside_text", "algorithm"}  # 正文段落
ROUTE_TEXT_ALL = ROUTE_TITLE | ROUTE_TEXT


def _cap_max_side(pil):
    w, h = pil.size
    longest = max(w, h)
    if longest <= MAX_SIDE:
        return pil
    ratio = MAX_SIDE / float(longest)
    from PIL import Image
    return pil.resize((max(1, int(w * ratio)), max(1, int(h * ratio))), Image.LANCZOS)


def _area(c):
    return max(0.0, (c[2] - c[0]) * (c[3] - c[1]))


def _fully_inside(inner, outer):
    return inner[0] >= outer[0] and inner[1] >= outer[1] and inner[2] <= outer[2] and inner[3] <= outer[3]


def overlap_ratio(a, b):
    """重叠度 = 交集 / 较小框面积"""
    ax1, ay1, ax2, ay2 = [float(v) for v in a]
    bx1, by1, bx2, by2 = [float(v) for v in b]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    return inter / max(1e-6, min(_area(a), _area(b)))


def dedup_regions(boxes, ratio=0.6, contain_ratio=0.8):
    """重叠区域去重: ① 包含关系保留大框(内容全) ② 近似重叠保留 score 高者"""
    result = []
    for b in boxes:
        contained = False
        for o in boxes:
            if o is b:
                continue
            bc, oc = b["coordinate"], o["coordinate"]
            if _area(bc) < _area(oc) and _fully_inside(bc, oc) and _area(bc) / _area(oc) < contain_ratio:
                contained = True
                break
        if not contained:
            result.append(b)
    kept = []
    for b in sorted(result, key=lambda x: x["score"], reverse=True):
        if not any(overlap_ratio(b["coordinate"], k["coordinate"]) > ratio for k in kept):
            kept.append(b)
    return kept


def adaptive_pad(region, all_boxes):
    """文字区域自适应 padding + 越界钳制(给 RapidOCR 检测器足够上下文, 不越过邻区)"""
    x1, y1, x2, y2 = [float(v) for v in region["coordinate"]]
    short = min(x2 - x1, y2 - y1)
    pad = max(16, int(short * 2))
    gap_cap = pad
    for o in all_boxes:
        if o is region:
            continue
        ox1, oy1, ox2, oy2 = [float(v) for v in o["coordinate"]]
        overlap_x = x1 < ox2 and ox1 < x2
        overlap_y = y1 < oy2 and oy1 < y2
        if overlap_x and overlap_y:
            gap = 0
        elif overlap_x:
            gap = max(0, min(abs(y1 - oy2), abs(oy1 - y2)))
        elif overlap_y:
            gap = max(0, min(abs(x1 - ox2), abs(ox1 - x2)))
        else:
            gap = max(0, min(abs(y1 - oy2), abs(oy1 - y2), abs(x1 - ox2), abs(ox1 - x2)))
        if 0 < gap < gap_cap:
            gap_cap = gap
    return max(0, min(pad, int(gap_cap)))


class RoutingOCR:
    """路由 OCR 引擎(懒加载各子模型, 全局复用)"""

    def __init__(self):
        from paddleocr import (
            LayoutDetection,
            TableClassification,
            TableStructureRecognition,
            TableCellsDetection,
            FormulaRecognition,
        )
        from rapidocr import RapidOCR

        self.TableStructureRecognition = TableStructureRecognition
        self.TableCellsDetection = TableCellsDetection
        self.layout = LayoutDetection(model_name="PP-DocLayout-L", threshold=LAYOUT_THRESHOLD)
        self.table_cls = TableClassification(model_name="PP-LCNet_x1_0_table_cls")
        self.structs = {}    # wired/wireless → TableStructureRecognition
        self.celldets = {}   # wired/wireless → TableCellsDetection
        self.formula = FormulaRecognition(model_name="PP-FormulaNet_plus-S")
        self.rapid = RapidOCR()

    # ---------- 路由 ----------
    def ocr_text_region(self, crop, region_box, offset_x, offset_y):
        """文字区域: RapidOCR + 按原始区域过滤文本行
        offset_x/offset_y 为裁图左上角在页面坐标系中的偏移"""
        res = self.rapid(np.array(crop))
        txts = getattr(res, "txts", None)
        boxes = getattr(res, "boxes", None)
        if txts is None:
            txts = []
        if boxes is None:
            boxes = []
        rx1, ry1, rx2, ry2 = [float(v) for v in region_box]
        kept = []
        for line, box in zip(txts, boxes):
            if not line or not str(line).strip():
                continue
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            if not xs or not ys:
                continue
            cx, cy = sum(xs) / len(xs) + offset_x, sum(ys) / len(ys) + offset_y  # 换算回页面坐标
            if rx1 <= cx <= rx2 and ry1 <= cy <= ry2:
                kept.append(str(line).strip())
        return "\n".join(kept)

    def table_full(self, crop, wired, depth=0):
        """表格: SLANet 结构 + RT-DETR 单元格 + 整表 RapidOCR 填格; 单列→递归版面"""
        key = "wired" if wired else "wireless"
        if key not in self.structs:
            self.structs[key] = self.TableStructureRecognition(
                model_name="SLANeXt_wired" if wired else "SLANet_plus")
        if key not in self.celldets:
            self.celldets[key] = self.TableCellsDetection(
                model_name="RT-DETR-L_wired_table_cell_det" if wired else "RT-DETR-L_wireless_table_cell_det")
        st = self.structs[key].predict(np.array(crop))[0]
        nrows = 0
        row_widths = []
        for tok in st["structure"]:
            t = tok.strip()
            if t == "<tr>":
                nrows += 1
                row_widths.append(0)
            elif t == "<td></td>":
                if row_widths:
                    row_widths[-1] += 1
        ncols = max(row_widths) if row_widths else 0
        if nrows == 0 or ncols == 0:
            return "[表格:SLANet 结构异常]"
        if ncols == 1:
            # 单列表格 = 文本框 → 忽略表格识别, 递归看内部版面(标题由版面模型定)
            return self.textbox_to_md(crop, depth)
        cells = sorted(self.celldets[key].predict(np.array(crop))[0]["boxes"],
                       key=lambda b: (b["coordinate"][1], b["coordinate"][0]))
        if not cells:
            return "[表格:未检出单元格]"
        res = self.rapid(np.array(crop))
        txts = getattr(res, "txts", None)
        bxs = getattr(res, "boxes", None)
        if txts is None:
            txts = []
        if bxs is None:
            bxs = []
        cell_xy = [(b["coordinate"][0], b["coordinate"][1], b["coordinate"][2], b["coordinate"][3]) for b in cells]
        cell_texts = [[] for _ in cells]
        for line, box in zip(txts, bxs):
            if not line or not str(line).strip():
                continue
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            if not xs or not ys:
                continue
            cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
            for i, (x1, y1, x2, y2) in enumerate(cell_xy):
                if x1 <= cx <= x2 and y1 <= cy <= y2:
                    cell_texts[i].append(str(line).strip())
                    break
        texts = [" ".join(t) for t in cell_texts]
        if len(texts) == nrows * ncols:
            grid = [texts[i * ncols:(i + 1) * ncols] for i in range(nrows)]
        else:
            items = []
            for b, txt in zip(cells, texts):
                c = b["coordinate"]
                items.append(((c[1] + c[3]) / 2, (c[0] + c[2]) / 2, txt))
            items.sort(key=lambda x: x[0])
            rows = [[items[0]]] if items else []
            for i in range(1, len(items)):
                if items[i][0] - items[i - 1][0] > 15:
                    rows.append([])
                rows[-1].append(items[i])
            grid = []
            for r in rows:
                r.sort(key=lambda x: x[1])
                grid.append([it[2] for it in r])
        lines = ["| " + " | ".join(row) + " |" for row in grid]
        sep = "| " + " | ".join(["---"] * len(grid[0])) + " |"
        return "\n".join([lines[0], sep] + lines[1:])

    def textbox_to_md(self, crop, depth=0):
        """单列表格(文本框) → 递归内部版面分析; 深度上限 3 防死循环"""
        sub = self.layout.predict(np.array(crop))
        sub_boxes = dedup_regions(sub[0]["boxes"])
        if depth >= 3 or not sub_boxes:
            res = self.rapid(np.array(crop))
            txts = getattr(res, "txts", None)
            if txts is None:
                txts = []
            return "\n".join(str(t).strip() for t in txts if str(t).strip())
        return "\n\n".join(self.route_page(crop, sub_boxes, depth + 1))

    def route_page(self, img_pil, boxes, depth=0):
        """对一张图像按版面区域路由 → md 片段列表"""
        parts = []
        for b in sorted(boxes, key=lambda x: (x["coordinate"][1], x["coordinate"][0])):
            label = b["label"]
            rx1, ry1, rx2, ry2 = [int(v) for v in b["coordinate"]]
            pad = adaptive_pad(b, boxes) if label in ROUTE_TEXT_ALL else 5
            x1, y1, x2, y2 = max(0, rx1 - pad), max(0, ry1 - pad), min(img_pil.width, rx2 + pad), min(img_pil.height, ry2 + pad)
            crop = img_pil.crop((x1, y1, x2, y2))
            if label in ROUTE_TEXT_ALL:
                text = self.ocr_text_region(crop, b["coordinate"], x1, y1)
                if label in ROUTE_TITLE:
                    if text.strip():
                        parts.append("## " + text.strip().replace("\n", " ").strip())
                elif text.strip():
                    parts.append(text.strip())
            elif label == "table":
                try:
                    cls_res = self.table_cls.predict(np.array(crop))[0]
                    scores = cls_res["scores"][0]
                    idx = int(np.argmax(scores))
                    names = cls_res["label_names"]
                    wired = bool(names[idx].startswith("wired")) if names and len(names) > idx else True
                    parts.append(self.table_full(crop, wired, depth))
                except Exception as e:
                    parts.append("[表格识别失败: %s]" % str(e)[:80])
            elif label in ("formula", "formula_title"):
                try:
                    fres = self.formula.predict(np.array(crop))
                    latex = fres[0]["rec_formula"]
                    parts.append("$$ %s $$" % latex)
                except Exception as e:
                    parts.append("$$ [公式识别失败: %s] $$" % str(e)[:80])
            elif label in ("seal", "stamp"):
                parts.append("<!-- 印章 -->")
        return parts


def main():
    src = sys.argv[1]
    scale = 2.0
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--scale" and i + 1 < len(args):
            scale = float(args[i + 1])
            i += 2
        else:
            i += 1

    warnings = []
    try:
        engine = RoutingOCR()
    except Exception as e:
        print(json.dumps({"ok": False, "error": "OCR 引擎初始化失败: %s" % str(e)[:300]}, ensure_ascii=False))
        return 1

    try:
        pdf = pdfium.PdfDocument(src)
        total = len(pdf)
        pages_md = []
        for pno in range(total):
            try:
                img = _cap_max_side(pdf[pno].render(scale=scale).to_pil().convert("RGB"))
                boxes = dedup_regions(engine.layout.predict(np.array(img))[0]["boxes"])
                parts = ["<!-- page %d -->" % (pno + 1)] + engine.route_page(img, boxes)
                pages_md.append("\n\n".join(parts))
            except Exception as e:
                warnings.append("第 %d 页处理失败:%s" % (pno + 1, str(e)[:200]))
        payload = {"ok": True, "md": "\n\n".join(pages_md)}
        if warnings:
            payload["warnings"] = warnings
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())

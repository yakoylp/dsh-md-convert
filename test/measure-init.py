# -*- coding: utf-8 -*-
"""测量 PPStructureV3 引擎初始化耗时与加载模型清单(支持 mobile 模型对比)"""
import os
import re
import sys
import time

os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "true")

use_mobile = "--mobile" in sys.argv

from paddleocr import PPStructureV3

models = []
orig_stderr = sys.stderr


class Cap:
    def write(self, s):
        for m in re.finditer(r"Creating model: \('([^']+)'", s):
            models.append(m.group(1))
        return len(s)


cap = Cap()
sys.stderr = cap
t = time.time()
engine = PPStructureV3(
    lang="ch",
    use_doc_orientation_classify=True,
    use_doc_unwarping=True,
    use_textline_orientation=True,
    use_formula_recognition=False,
    use_seal_recognition=False,
    use_chart_recognition=False,
    text_detection_model_name="PP-OCRv5_mobile_det" if use_mobile else None,
    text_recognition_model_name="PP-OCRv5_mobile_rec" if use_mobile else None,
    enable_mkldnn=False,
)
init = time.time() - t
sys.stderr = orig_stderr

seen = []
for m in models:
    if m not in seen:
        seen.append(m)
print("配置: %s" % ("MOBILE det/rec" if use_mobile else "SERVER det/rec(默认)"))
print("初始化耗时: %.1fs" % init)
print("加载模型数: %d" % len(seen))
for m in seen:
    print("  -", m)

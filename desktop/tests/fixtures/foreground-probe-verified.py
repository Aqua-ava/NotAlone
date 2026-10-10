"""仅返回合成的最小区域质量证据；不访问微信或图帧。"""

import json
import sys


if __name__ == "__main__":
    if sys.argv[1:] != ["--session", "--json", "--minimal-region"]:
        raise ValueError("合成定位探针只允许一次最小区域观察。")
    print(json.dumps({
        "ok": True, "wechat_in_front": True,
        "display_name": "唯一合成会话", "selected_row_name": "唯一合成会话",
        "capture_version": "minimal-region-v1",
        "quality": {
            "layout_verified": True, "display_name_confidence": 0.95,
            "selected_row_name_confidence": 0.96,
        },
    }))

"""合成前台状态输入：可见会话故意缺少区域与OCR质量，不读取图帧。"""

import json
import sys
from pathlib import Path


if __name__ == "__main__":
    if sys.argv[1:] != ["--session", "--json", "--minimal-region", "--single-frame"]:
        raise ValueError("合成定位探针只允许最小区域观察协议。")
    state = json.loads((Path(__file__).parent / "probe-state.json").read_text())
    if set(state) != {"wechat_in_front"} or not isinstance(state["wechat_in_front"], bool):
        raise ValueError("本轮合成探针状态不可核验。")
    result = {"ok": True, "wechat_in_front": state["wechat_in_front"]}
    if state["wechat_in_front"]:
        result["display_name"] = "同名联系人"
    print(json.dumps(result))

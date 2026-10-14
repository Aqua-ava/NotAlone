"""仅返回合成的最小区域质量证据；不访问微信或图帧。"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


if __name__ == "__main__":
    if sys.argv[1:] != ["--session", "--json", "--minimal-region", "--single-frame"]:
        raise ValueError("合成定位探针只允许一次最小区域观察。")
    state_path = Path(__file__).parent / "probe-state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    print(json.dumps({
        "ok": True, "wechat_in_front": True,
        "display_name": state.get("display_name", "唯一合成会话"),
        "selected_row_name": state.get("selected_row_name", "唯一合成会话"),
        "capture_version": state.get("capture_version", "automatic-window-v2"),
        "captured_at": state.get("captured_at", datetime.now(timezone.utc).isoformat()),
        "quality": {
            "layout_verified": True, "display_name_confidence": 0.95,
            "selected_row_name_confidence": state.get("selected_row_name_confidence", 0.96),
        },
    }))

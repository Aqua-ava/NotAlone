"""仅返回合成的最小区域质量证据；不访问微信或图帧。"""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID


def observe():
    # 每轮重新读取合成输入，常驻进程不能复用上一轮会话结果。
    state_path = Path(__file__).parent / "probe-state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    delay = state.get("delay_seconds", 0)
    if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not 0 <= delay <= 5:
        raise ValueError("合成观察延迟必须在五秒内。")
    if delay:
        time.sleep(delay)
    if state.get("error"):
        return {"ok": False, "stage": "context", "error": state["error"]}
    version = state.get("capture_version", "automatic-window-v2")
    payload = {
        "ok": True, "wechat_in_front": state.get("wechat_in_front", True),
        "display_name": state.get("display_name", "唯一合成会话"),
        "capture_version": version,
        "captured_at": state.get("captured_at", datetime.now(timezone.utc).isoformat()),
        "quality": {
            "layout_verified": True,
            "display_name_confidence": state.get("display_name_confidence", 0.95),
        },
    }
    if version in ("automatic-header-v3", "automatic-header-v4"):
        payload["quality"]["name_complete"] = state.get("name_complete", True)
        if "text_fallback" in state:
            payload["text_fallback"] = state["text_fallback"]
    else:
        payload["selected_row_name"] = state.get("selected_row_name", "唯一合成会话")
        payload["quality"]["selected_row_name_confidence"] = state.get("selected_row_name_confidence", 0.96)
    return payload


def main():
    if sys.argv[1:] == ["--session", "--json", "--minimal-region", "--single-frame"]:
        print(json.dumps(observe()), flush=True)
    elif sys.argv[1:] == ["--session-worker", "--json"]:
        print(json.dumps({"version": 1, "event": "ready"}), flush=True)
        previous_ids = set()
        for line in sys.stdin:
            request = json.loads(line)
            if (not isinstance(request, dict) or set(request) != {"version", "request_id", "operation"}
                    or type(request["version"]) is not int or request["version"] != 1
                    or request["operation"] != "observe"
                    or not isinstance(request["request_id"], str)
                    or str(UUID(request["request_id"])) != request["request_id"]
                    or request["request_id"] in previous_ids):
                raise ValueError("合成定位探针请求身份或协议不可核验。")
            previous_ids.add(request["request_id"])
            print(json.dumps({"version": 1, "request_id": request["request_id"], "result": observe()}), flush=True)
    else:
        raise ValueError("合成定位探针只允许最小区域单次观察或有界常驻协议。")


if __name__ == "__main__":
    main()

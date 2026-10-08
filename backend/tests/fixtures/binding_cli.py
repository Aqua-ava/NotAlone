"""只读取本轮合成文件的 CLI 进程边界；绝不访问微信。"""

import json
import os
from pathlib import Path
import sys
import time


directory = Path(os.environ["NOTALONE_TEST_BINDING_DIRECTORY"])
arguments = sys.argv[1:]
command = arguments[0]
if command == "--version":
    print(json.dumps({"ok": True, "data": {"version": "1.6.20-synthetic"}}))
elif command == "sessions":
    if (directory / "sessions-failed").exists():
        raise SystemExit(1)
    state = json.loads((directory / "cli-state.json").read_text())
    # 仅延迟合成进程的元数据输出，验证 App 复读与服务端最终复读间的变化。
    gate = directory / "hold-sessions"
    if gate.exists():
        (directory / "held-sessions-ready").touch()
        deadline = time.monotonic() + 15
        while gate.exists():
            if time.monotonic() >= deadline:
                raise SystemExit(1)
            time.sleep(0.02)
    print(json.dumps({"ok": True, "data": {"sessions": state["sessions"]}}))
elif command == "tail" and "--follow" in arguments:
    # 合成边界明确不支持全局流，实际引擎走原有有界轮询。
    raise SystemExit(1)
elif command == "tail":
    locator = arguments[1]
    with (directory / "tail-calls.jsonl").open("a") as log:
        log.write(json.dumps({"locator": locator}) + "\n")
    deadline = time.monotonic() + 15
    while (directory / f"hold-tail-{locator}").exists():
        if time.monotonic() >= deadline:
            raise SystemExit(1)
        time.sleep(0.02)
    state = json.loads((directory / "cli-state.json").read_text())
    cursor = arguments[arguments.index("--cursor") + 1] if "--cursor" in arguments else "local_id:0"
    after = int(cursor.partition(":")[2])
    for message in state.get("messages", {}).get(locator, []):
        if message["local_id"] <= after:
            continue
        print(json.dumps({"type": "message", "cursor": f"local_id:{message['local_id']}", "message": {
            "id": {"local_id": message["local_id"], "talker": locator}, "kind": "text",
            "text": message["text"], "create_time": message["create_time"], "is_from_me": False,
        }}))
else:
    raise SystemExit(1)

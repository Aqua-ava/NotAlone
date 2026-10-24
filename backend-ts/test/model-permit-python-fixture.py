"""只用合成执行事件；stdin 的 settle 表示模拟 SDK 已实际返回。"""
import json
import sys
from notalone.application.model_permit_client import SharedModelPriorityControl

config = json.loads(sys.stdin.readline())
control = SharedModelPriorityControl(
    socket_path=config["path"], token=config["token"],
)
with control.background_call():
    print("granted", flush=True)
    if config.get("includeIdentity"):
        print(json.dumps(control.current_call_identity), flush=True)
    command = sys.stdin.readline().strip()
    if command == "cancel":
        control.stop()
        print("cancelled_but_in_flight", flush=True)
        sys.stdin.readline()
print("settled", flush=True)

"""单轮真实顶部观察反馈环；名称只在内存比较，输出阶段和脱敏判定。"""
import argparse
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid


parser = argparse.ArgumentParser()
parser.add_argument("--probe", required=True)
parser.add_argument("--timeout-ms", type=int, default=2500)
args = parser.parse_args()
target = os.environ.get("NOTALONE_TEST_WECHAT_NAME")
if not target or not 1 <= args.timeout_ms <= 2500:
    raise SystemExit("缺少本轮已授权名称或预算无效")
request_id = str(uuid.uuid4())
request = {"version": 1, "request_id": request_id, "operation": "observe"}
started = time.monotonic()
child = subprocess.Popen(
    [args.probe, "--session-worker", "--json"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C",
         "NOTALONE_OBSERVATION_MEASUREMENTS": "1"},
)
timed_out = False
try:
    stdout, stderr = child.communicate(
        (json.dumps(request) + "\n").encode(), timeout=args.timeout_ms / 1000)
except subprocess.TimeoutExpired:
    timed_out = True
    child.kill()
    stdout, stderr = child.communicate(timeout=2)
rows = []
protocol_valid = len(stdout) <= 131072
if protocol_valid:
    try:
        rows = [json.loads(line) for line in stdout.splitlines() if line]
    except (ValueError, UnicodeError):
        protocol_valid = False
response = next((row for row in rows if isinstance(row, dict)
                 and row.get("request_id") == request_id), {})
result = response.get("result", {})
if not isinstance(result, dict):
    result = {}
events = []
for line in stderr.decode("utf-8", errors="replace").splitlines():
    match = re.fullmatch(r"notalone-observation-v1 ([A-Za-z]+) ([0-9.]+)", line)
    if match:
        events.append({"stage": match[1], "monotonic_seconds": float(match[2])})
ready_valid = bool(rows) and rows[0] == {"version": 1, "event": "ready"}
matched = result.get("display_name") == target
passed = (not timed_out and child.returncode == 0 and protocol_valid
          and ready_valid and response.get("version") == 1
          and result.get("ok") is True and result.get("wechat_in_front") is True
          and result.get("capture_version") == "automatic-header-v4" and matched)
with open(args.probe, "rb") as stream:
    binary_hash = hashlib.file_digest(stream, "sha256").hexdigest()
print(json.dumps({
    "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "passed": passed, "timeout_ms": args.timeout_ms, "timed_out": timed_out,
    "duration_ms": round((time.monotonic() - started) * 1000, 1),
    "exit_code": child.returncode, "binary_sha256": binary_hash,
    "protocol_valid": protocol_valid, "ready_valid": ready_valid,
    "response_correlated": bool(response), "ok": result.get("ok"),
    "wechat_in_front": result.get("wechat_in_front"),
    "capture_version": result.get("capture_version"),
    "expected_name_matched": matched, "events": events,
    "stderr_bytes": len(stderr),
}, ensure_ascii=False))
sys.exit(0 if passed else 1)

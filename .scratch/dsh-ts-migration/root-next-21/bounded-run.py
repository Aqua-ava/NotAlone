"""运行一次纯合成诊断，按截止时间终止并回收自有子进程。"""

import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import time


parser = argparse.ArgumentParser()
parser.add_argument("--runner", required=True, type=pathlib.Path)
parser.add_argument("--arg", action="append", default=[])
parser.add_argument("--timeout-ms", type=int, default=2500)
args = parser.parse_args()
if not args.runner.is_absolute() or not 1 <= args.timeout_ms <= 30000:
    raise SystemExit("runner 必须为绝对路径；截止必须在 1 至 30000ms")

started = time.monotonic()
try:
    child = subprocess.Popen(
        [str(args.runner), *args.arg],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
    )
except OSError as error:
    print(json.dumps({
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "runner": str(args.runner),
        "arguments": args.arg,
        "runner_sha256": hashlib.sha256(args.runner.read_bytes()).hexdigest(),
        "timeout_ms": args.timeout_ms,
        "launch_error": str(error),
        "duration_ms": round((time.monotonic() - started) * 1000, 1),
    }, ensure_ascii=False))
    raise SystemExit(1)
timed_out = False
try:
    try:
        stdout, stderr = child.communicate(timeout=args.timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        child.kill()
        stdout, stderr = child.communicate(timeout=2)
finally:
    if child.poll() is None:
        child.kill()
    stdout, stderr = child.communicate(timeout=2)

try:
    events = [json.loads(line) for line in stdout.splitlines()]
    protocol_valid = True
except (ValueError, UnicodeError):
    events = []
    protocol_valid = False
completed = any(
    isinstance(event, dict) and event.get("event") == "ocr_completed"
    for event in events
)
print(json.dumps({
    "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "runner": str(args.runner),
    "arguments": args.arg,
    "runner_sha256": hashlib.sha256(args.runner.read_bytes()).hexdigest(),
    "timeout_ms": args.timeout_ms,
    "timed_out": timed_out,
    "child_pid": child.pid,
    "child_exit": child.returncode,
    "duration_ms": round((time.monotonic() - started) * 1000, 1),
    "protocol_valid": protocol_valid,
    "ocr_completed": completed,
    "stderr_bytes": len(stderr),
    "events": events,
}, ensure_ascii=False))
raise SystemExit(0 if not timed_out and child.returncode == 0 and protocol_valid else 1)

"""纯合成 OCR 单场反馈环；超时杀死并等待本脚本创建的子进程。"""
import argparse
import datetime
import hashlib
import json
import pathlib
import subprocess
import sys
import time


parser = argparse.ArgumentParser()
parser.add_argument("--runner", required=True, type=pathlib.Path)
parser.add_argument("--mode", required=True, choices=["library", "direct", "devices", "cpu", "inventory", "revision"])
parser.add_argument("--revision", type=int)
parser.add_argument("--timeout-ms", type=int, default=2500)
args = parser.parse_args()
if not args.runner.is_absolute() or not 1 <= args.timeout_ms <= 30000:
    raise SystemExit("合成程序须使用绝对路径；诊断预算必须在 1 至 30000ms")
if (args.mode == "revision") != (args.revision is not None) or (args.revision is not None and args.revision <= 0):
    raise SystemExit("仅 revision 模式必须提供正整数 --revision")
root = pathlib.Path(__file__).resolve().parents[3]
core = root / "native/macos/build/cli/libNotAloneSyncCore.dylib"
runner_hash = hashlib.sha256(args.runner.read_bytes()).hexdigest()
core_hash = hashlib.sha256(core.read_bytes()).hexdigest()
started = time.monotonic()
command = [str(args.runner), args.mode]
if args.revision is not None:
    command.append(str(args.revision))
child = subprocess.Popen(
    command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
)
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
protocol_valid = True
try:
    events = [json.loads(line) for line in stdout.splitlines()]
except (ValueError, UnicodeError):
    protocol_valid = False
    events = []
completed = any(event.get("event") == "ocr_completed" for event in events if isinstance(event, dict))
inventory_completed = any(event.get("event") == "inventory_completed" for event in events if isinstance(event, dict))
passed = not timed_out and child.returncode == 0 and protocol_valid and (inventory_completed if args.mode == "inventory" else completed)
print(json.dumps({
    "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "passed": passed, "mode": args.mode, "revision": args.revision, "timeout_ms": args.timeout_ms,
    "timed_out": timed_out, "child_pid": child.pid, "child_exit": child.returncode,
    "duration_ms": round((time.monotonic() - started) * 1000, 1),
    "runner_sha256": runner_hash,
    "core_sha256_before": core_hash,
    "core_sha256_after": hashlib.sha256(core.read_bytes()).hexdigest(),
    "runner_sha256_after": hashlib.sha256(args.runner.read_bytes()).hexdigest(),
    "protocol_valid": protocol_valid, "ocr_completed": completed,
    "stderr_bytes": len(stderr), "events": events,
}, ensure_ascii=False))
sys.exit(0 if passed else 1)

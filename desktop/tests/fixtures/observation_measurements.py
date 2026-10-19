"""有限实机验收的只读测量；不记录协议正文或改变生产返回值。"""

import json
import math
import os
from pathlib import Path
import resource
import subprocess
import threading
import time

EVENTS = (
    "started", "foregroundAccepted", "captureRequested", "captureCompleted",
    "frameReceived", "headerOcrStarted", "headerOcrCompleted", "finished",
)


def native_result(stdout):
    """固定结果分类；正常进程退出不等于原生观察成功。"""
    try:
        value = json.loads(stdout)
    except (ValueError, TypeError):
        return "invalid"
    if not isinstance(value, dict):
        return "invalid"
    if value.get("ok") is False:
        return "native-failed"
    if value.get("ok") is not True:
        return "invalid"
    if value.get("wechat_in_front") is False:
        return "paused"
    if value.get("wechat_in_front") is True:
        return "recognized"
    return "invalid"


def summarize_native(raw):
    """超时的部分stderr保留已发生计数，缺少结束事件不补造成功。"""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    events = []
    valid = isinstance(raw, str) and len(raw) <= 8192
    if valid:
        for line in raw.splitlines():
            if not line.startswith("notalone-observation-v1 "):
                continue
            parts = line.split()
            try:
                stamp = float(parts[2])
                if len(parts) != 3 or parts[1] not in EVENTS or not math.isfinite(stamp) or stamp < 0:
                    raise ValueError
                if events and stamp < events[-1][1]:
                    raise ValueError
                events.append((parts[1], stamp))
            except (IndexError, ValueError):
                valid = False
    names = [event[0] for event in events]
    valid = (valid and len(events) <= 8 and len(names) == len(set(names))
             and [EVENTS.index(name) for name in names] == sorted(EVENTS.index(name) for name in names))
    complete = valid and bool(events) and names[0] == "started" and names[-1] == "finished"
    values = dict(events)

    def duration(start, end):
        if not valid or start not in values or end not in values or values[end] < values[start]:
            return None
        return round((values[end] - values[start]) * 1000, 3)

    return {
        "complete": complete, "valid": valid and bool(events),
        "capture_requests": names.count("captureRequested"),
        "capture_completions": names.count("captureCompleted"),
        "frames_received": names.count("frameReceived"),
        "header_ocr_calls": names.count("headerOcrStarted"),
        "native_ms": duration("started", "finished"),
        "capture_ms": duration("captureRequested", "captureCompleted"),
        "ocr_ms": duration("headerOcrStarted", "headerOcrCompleted"),
    }


def install():
    """仅在受限后端中旁路计时既有调用，不另起进程或发出请求。"""
    from notalone.server.app import BackendApp
    from notalone.front_sync.session_worker import NativeSessionWorker, SessionWorkerError
    global register_cli_read_causes

    destination = Path(os.environ["NOTALONE_OBSERVATION_MEASUREMENT_FILE"])
    probe = os.environ["NOTALONE_SYNC_PROBE"]
    lock = threading.Lock()
    original_run = subprocess.run
    original_handle = BackendApp.handle
    original_worker_observe = NativeSessionWorker.observe

    def record(value):
        # 只接受本模块构造的数值/固定枚举；失败会使本轮验收缺证，不默默丢弃。
        with lock:
            if value["kind"] != "installed":
                own = resource.getrusage(resource.RUSAGE_SELF)
                children = resource.getrusage(resource.RUSAGE_CHILDREN)
                value = {**value, "backend_cpu_ms": (own.ru_utime + own.ru_stime) * 1000,
                         "backend_max_rss_bytes": own.ru_maxrss,
                         "backend_children_cpu_ms": (children.ru_utime + children.ru_stime) * 1000,
                         "backend_child_max_rss_bytes": children.ru_maxrss}
            with destination.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(value, allow_nan=False) + "\n")

    def register_cli_read_causes(cli, processes):
        from sync_read_causes import attach
        attach(cli, processes, record)

    def measured_run(command, *args, **kwargs):
        if not isinstance(command, (tuple, list)) or not command or command[0] != probe:
            return original_run(command, *args, **kwargs)
        start = time.monotonic()
        started_at = time.time() * 1000
        record({"kind": "probe-start", "started_at_ms": started_at})
        stderr = None
        outcome = "failed"
        native_status = "unknown"
        try:
            result = original_run(command, *args, **kwargs)
            stderr = result.stderr
            native_status = native_result(result.stdout)
            outcome = "returned" if result.returncode == 0 else "failed"
            return result
        except subprocess.TimeoutExpired as error:
            stderr = error.stderr
            outcome = "timeout"
            raise
        finally:
            record({"kind": "probe", "started_at_ms": started_at,
                    "elapsed_ms": (time.monotonic() - start) * 1000,
                    "single_frame_requested": "--single-frame" in command,
                    "outcome": outcome, "native_status": native_status, **summarize_native(stderr)})

    def measured_worker_observe(self, *args, **kwargs):
        if self._executable != probe:
            return original_worker_observe(self, *args, **kwargs)
        start = time.monotonic()
        started_at = time.time() * 1000
        record({"kind": "probe-start", "started_at_ms": started_at})
        outcome = "failed"
        native_status = "unknown"
        try:
            result = original_worker_observe(self, *args, **kwargs)
            native_status = native_result(json.dumps(result))
            outcome = "returned"
            return result
        except SessionWorkerError as error:
            outcome = "timeout" if error.code == "probe_timeout" else "failed"
            raise
        finally:
            # 常驻协议不返回原生 stderr；只记录真实请求，不补造图帧或 OCR 耗时。
            record({"kind": "probe", "transport": "worker", "started_at_ms": started_at,
                    "elapsed_ms": (time.monotonic() - start) * 1000,
                    "single_frame_requested": True, "outcome": outcome,
                    "native_status": native_status, **summarize_native(None)})

    def measured_handle(self, **kwargs):
        if kwargs.get("method") != "POST" or kwargs.get("path") != "/api/sync/foreground/observe":
            return original_handle(self, **kwargs)
        start = time.monotonic()
        started_at = time.time() * 1000
        try:
            return original_handle(self, **kwargs)
        finally:
            record({"kind": "backend", "started_at_ms": started_at,
                    "elapsed_ms": (time.monotonic() - start) * 1000})

    subprocess.run = measured_run
    NativeSessionWorker.observe = measured_worker_observe
    BackendApp.handle = measured_handle
    record({"kind": "installed"})

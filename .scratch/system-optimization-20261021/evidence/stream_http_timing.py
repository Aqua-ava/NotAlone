"""无 tracemalloc 的交错计时；参数为基线根、候选根、结果 JSON。"""

import fcntl
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path


def child():
    from datetime import datetime, timezone
    from uuid import UUID
    from notalone.scopes import ContactScope
    from notalone.server.event_bus import EventBus
    from notalone.server.event_models import BackendEvent
    from notalone.wechat_cli.adapter import SessionEventStream
    from stream_http_measure import Process

    started = time.perf_counter()
    stream = SessionEventStream(Process(5000))
    for index in range(5000):
        assert stream.read(timeout=2).cursor == str(index)
    assert stream.read(timeout=2) is None
    stream.close()
    cli = time.perf_counter() - started
    scope = ContactScope(UUID(int=1), UUID(int=2))
    now = datetime(2026, 10, 21, tzinfo=timezone.utc)
    bus = EventBus()
    streams = [bus.subscribe(owner_id=scope.owner_id) for _ in range(2)]
    started = time.perf_counter()
    for index in range(5000):
        event = BackendEvent.sync_status_changed(
            scope=scope, occurred_at=now, phase="active", sync_enabled=True,
            failure_code=None, event_id=UUID(int=index + 3))
        bus.publish(event)
        for current in streams:
            assert current.read(timeout=0) is event
    bus_seconds = time.perf_counter() - started
    bus.close()
    print(json.dumps({"cli_5000_produce_consume_seconds": cli,
                      "sse_5000_two_healthy_subscribers_seconds": bus_seconds}))


def parent():
    baseline, candidate, output = map(Path, sys.argv[1:])
    samples = {"baseline": [], "candidate": []}
    with open("/tmp/notalone-optimization-benchmark.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for iteration in range(7):
            order = [("baseline", baseline), ("candidate", candidate)]
            if iteration % 2:
                order.reverse()
            for label, root in order:
                env = {**os.environ, "PYTHONPATH": str(root / "backend/src"),
                       "PYTHONDONTWRITEBYTECODE": "1"}
                value = subprocess.run([sys.executable, __file__, "--child"], env=env,
                                       capture_output=True, check=True, text=True)
                samples[label].append(json.loads(value.stdout))
    summary = {}
    for label, values in samples.items():
        summary[label] = {}
        for metric in values[0]:
            ordered = sorted(row[metric] for row in values)
            summary[label][metric] = {"p50": statistics.median(ordered),
                                      "p95_nearest_rank": ordered[-1]}
    output.write_text(json.dumps({"samples": samples, "summary": summary,
                                  "runs_per_version": 7, "no_tracemalloc": True,
                                  "note": "7 点 p95 为最大样本；仅本机合成吞吐，非用户消息延迟"},
                                 ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary))


if __name__ == "__main__":
    child() if sys.argv[1:] == ["--child"] else parent()

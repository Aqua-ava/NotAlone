"""仅合成数据；通过 PYTHONPATH 选择固定基线或候选源码。"""

import argparse
import fcntl
import gc
import hashlib
import json
import socket
import sys
import threading
import time
import tracemalloc
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.server.app import BackendApp, BackendServer
from notalone.server.event_bus import EventBus
from notalone.server.event_models import BackendEvent
from notalone.wechat_cli.adapter import SessionEventStream


class Process:
    def __init__(self, count):
        self.count = count
        self.emitted = 0
        self.terminated = False

    def readline(self):
        if self.terminated or self.emitted == self.count:
            return ""
        index = self.emitted
        self.emitted += 1
        return json.dumps({"type": "session", "cursor": str(index),
                           "username": f"synthetic-{index % 10}"}) + "\n"

    def poll(self):
        return 0

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0


def queued(stream):
    value = stream._queue
    return value.qsize() if hasattr(value, "qsize") else len(value)


def cli_case(count):
    process = Process(count)
    gc.collect()
    tracemalloc.start()
    stream = SessionEventStream(process)
    import notalone.wechat_cli.adapter as adapter_module
    bounded = hasattr(adapter_module, "_MAX_PENDING_SESSION_EVENTS")
    stream._reader.join(timeout=0.25 if bounded else 15)
    if not bounded:
        assert not stream._reader.is_alive()
    retained, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    result = {"events": count, "queued": queued(stream),
              "upstream_read": process.emitted,
              "retained_bytes": retained, "peak_bytes": peak}
    started = time.perf_counter()
    for index in range(count):
        event = stream.read(timeout=2)
        assert event.cursor == str(index)
    assert stream.read(timeout=2) is None
    stream.close()
    stream._reader.join(timeout=2)
    assert not stream._reader.is_alive()
    result.update(drain_seconds=time.perf_counter() - started,
                  ordered_events=count, reader_stopped=True)
    return result


def bus_case(count):
    scope = ContactScope(UUID(int=1), UUID(int=2))
    bus = EventBus()
    slow = bus.subscribe(owner_id=scope.owner_id)
    fast = bus.subscribe(owner_id=scope.owner_id)
    gc.collect()
    tracemalloc.start()
    started = time.perf_counter()
    for index in range(count):
        event = BackendEvent.sync_status_changed(
            scope=scope, occurred_at=datetime(2026, 10, 21, tzinfo=timezone.utc),
            phase="active", sync_enabled=True, failure_code=None,
            event_id=UUID(int=index + 3))
        bus.publish(event)
        assert fast.read(timeout=0) is event
    elapsed = time.perf_counter() - started
    retained, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    result = {"events": count, "slow_queued": queued(slow),
              "slow_closed": slow.closed, "fast_queued": queued(fast),
              "retained_bytes": retained, "peak_bytes": peak,
              "publish_seconds": elapsed, "fast_ordered_events": count}
    bus.close()
    result["queued_after_close"] = queued(slow)
    return result


def http_case():
    # 本路径只访问认证层，不构造数据库适配器或连接业务库。
    app = BackendApp(contact_directory=None, events=EventBus(),
                     owner_id=UUID(int=1), token="synthetic-test-token")
    server = BackendServer(app, port=0)
    address = server.start()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connections = []
    try:
        for _ in range(12):
            client = socket.create_connection(address, timeout=2)
            client.sendall(b"POST /api/unknown HTTP/1.0\r\nContent-Length: 100\r\n\r\nx")
            connections.append(client)
        responses = 0
        for client in connections:
            client.settimeout(0.05)
            try:
                response = client.recv(4096)
                assert b"401" in response.split(b"\r\n")[0]
                responses += 1
            except TimeoutError:
                pass
        workers = sum("process_request_thread" in item.name
                      for item in threading.enumerate())
        return {"incomplete_unauthorized_requests": len(connections),
                "responses_within_each_50ms_observation": responses,
                "request_workers_at_observation": workers,
                "note": "超时为删失观察，不能当作请求延迟"}
    finally:
        for client in connections:
            client.close()
        server.shutdown()
        thread.join(timeout=2)
        assert not thread.is_alive()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("--source-revision", required=True)
    args = parser.parse_args()
    with open("/tmp/notalone-optimization-benchmark.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        import notalone.server.app as app_module
        paths = [Path(app_module.__file__), Path(app_module.__file__).with_name("event_bus.py"),
                 Path(app_module.__file__).parents[1] / "wechat_cli" / "adapter.py"]
        limits = Path(app_module.__file__).with_name("http_limits.py")
        if limits.exists():
            paths.append(limits)
        description = "5000/100000 session metadata events, 10 synthetic locators; same-owner sync states; 12 unauthenticated partial bodies"
        result = {"source_revision": args.source_revision, "python_version": sys.version.split()[0],
                  "source_sha256": {"backend/src/" + str(path).split("/backend/src/")[1]: hashlib.sha256(path.read_bytes()).hexdigest()
                                    for path in paths},
                  "input": description,
                  "input_recipe_sha256": hashlib.sha256(description.encode()).hexdigest(),
                  "cli": [cli_case(count) for count in (5000, 100000)],
                  "bus": [bus_case(count) for count in (5000, 100000)],
                  "http": http_case()}
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

"""验证启动恢复和退出边界的合成子进程；HTTP 使用本轮源码的 BackendServer。"""

import os
from pathlib import Path
import signal
import threading
import time

marker = Path(os.environ["NOTALONE_TEST_START_MARKER"])
release_path = os.environ.get("NOTALONE_TEST_START_RELEASE")
if release_path:
    marker.write_text("synthetic startup begun", encoding="utf-8")
    while not Path(release_path).exists():
        time.sleep(0.01)
elif not marker.exists():
    marker.write_text("synthetic startup failure", encoding="utf-8")
    raise SystemExit(2)

from notalone.server.app import BackendServer, create_app
from notalone.server.connection_info import remove_backend_info, write_backend_info

app = create_app(
    database_url="postgresql://127.0.0.1:1/notalone_synthetic_test",
    owner_id=None,
    runtime_shutdown=lambda: None,
)
server = BackendServer(app)
host, port = server.start()
write_backend_info(address=f"{host}:{port}", token=app.token)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()


def handle_termination(_signal: int, _frame: object) -> None:
    signal_marker = os.environ.get("NOTALONE_TEST_SIGNAL_MARKER")
    if signal_marker:
        Path(signal_marker).write_text("synthetic SIGTERM", encoding="utf-8")
    server.request_shutdown()


signal.signal(signal.SIGTERM, handle_termination)
try:
    thread.join()
finally:
    remove_backend_info()
    server.shutdown()
    exit_marker = os.environ.get("NOTALONE_TEST_EXIT_MARKER")
    if exit_marker:
        Path(exit_marker).write_text("synthetic cleanup complete", encoding="utf-8")

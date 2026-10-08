"""启动失败后可恢复的合成子进程；HTTP 仍使用本轮源码的 BackendServer。"""

import os
from pathlib import Path
import signal
import threading

marker = Path(os.environ["NOTALONE_TEST_START_MARKER"])
if not marker.exists():
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
signal.signal(signal.SIGTERM, lambda _signal, _frame: server.request_shutdown())
try:
    thread.join()
finally:
    remove_backend_info()
    server.shutdown()

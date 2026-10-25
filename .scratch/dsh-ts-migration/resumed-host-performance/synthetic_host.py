"""短测用合成进程；绝不作为 Python／DSH 性能基准。"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

child = subprocess.Popen([sys.executable, '-c', 'import time; allocation=bytearray(2**20); time.sleep(15)'])


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path=='/api/runtime/status':
            data={'state':'running','runtime':'synthetic'}
        else:
            data={'contacts':[]}
        self.send_response(503 if os.environ.get('NOTALONE_PERF_NEVER_READY')=='1' else 200)
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, *_args):
        pass


server = HTTPServer(('127.0.0.1', 0), Handler)
Path(os.environ['NOTALONE_BACKEND_INFO']).write_text(
    f'address=127.0.0.1:{server.server_port}\ntoken=synthetic\npid={os.getpid()}\n')


def stop(*_args):
    child.terminate()
    child.wait(timeout=2)
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)
try:
    server.serve_forever()
finally:
    child.terminate()
    child.wait(timeout=2)

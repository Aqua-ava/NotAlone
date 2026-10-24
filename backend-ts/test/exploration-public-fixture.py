"""为父 Node 测试启动正式 Python 公开 HTTP；不创建或删除测试库。

父进程通过 stdin EOF 或 SIGTERM 收尾。所有请求仍走正式 create_app 路由，
B/C 转发同一 TS 宿主；任何 Python 模型执行均立即失败，禁止回退旧运行时。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sys
import threading
from unittest.mock import patch
from uuid import UUID

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'backend' / 'src'), str(ROOT / 'backend')]

from psycopg.conninfo import conninfo_to_dict
from notalone.server.app import BackendServer, create_app
from notalone.server.reply_wiring import build_reply_service, close_reply_service
from tests.fidelity_http_support import FidelityControlledModel
from tests.input_budget_support import synthetic_budget_kwargs


class ForbiddenPythonModel(FidelityControlledModel):
    """仅供装配与预算身份；物理调用不是此测试的许可路径。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        raise AssertionError('public_fixture_python_model_forbidden')


def main():
    parser = argparse.ArgumentParser(description='启动 07 合成公开 HTTP 夹具')
    parser.add_argument('--database', required=True)
    parser.add_argument('--owner', required=True, type=UUID)
    parser.add_argument('--remote-url', required=True)
    parser.add_argument('--remote-token', required=True)
    args = parser.parse_args()
    database = conninfo_to_dict(args.database)
    if not re.fullmatch(r'[a-zA-Z0-9_]+_test', database.get('dbname', '')):
        parser.error('只允许父测试提供的 _test 测试库')
    if database.get('host', '') not in ('/tmp', '127.0.0.1', 'localhost'):
        parser.error('只允许回环合成测试库')

    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())

    def stdin_closed():
        # 不解释输入命令；只有 EOF 表示父测试不再持有夹具。
        while sys.stdin.buffer.read(4096):
            pass
        stopped.set()

    threading.Thread(target=stdin_closed, name='exploration-fixture-stdin', daemon=True).start()
    token = 'synthetic-public-' + secrets.token_urlsafe(32)
    model = ForbiddenPythonModel()
    service, server, thread = None, None, None
    try:
        environment = {'NOTALONE_TS_HOST': '1', 'NOTALONE_REPLY_RUNTIME': 'typescript',
                       'NOTALONE_REPLY_REMOTE_URL': args.remote_url,
                       'NOTALONE_REPLY_REMOTE_TOKEN': args.remote_token,
                       'DEEPSEEK_API_KEY': 'synthetic-loopback-only'}
        with patch.dict(os.environ, environment), \
             patch('notalone.server.reply_wiring.build_deepseek_model', return_value=model):
            service = build_reply_service(database_url=args.database, owner_id=args.owner,
                                          **synthetic_budget_kwargs(model))
            if service is None:
                raise RuntimeError('public_fixture_reply_unavailable')
            app = create_app(database_url=args.database, owner_id=args.owner, token=token,
                             reply_service=service, model_work_available=False,
                             runtime_shutdown=lambda: close_reply_service(service))
            server = BackendServer(app, port=0)
            host, port = server.start()
            thread = threading.Thread(target=server.serve_forever,
                                      name='exploration-fixture-http', daemon=True)
            thread.start()
            print('READY ' + json.dumps({'url': f'http://{host}:{port}', 'token': token,
                                        'manual_header': 'X-NotAlone-Manual-Contact'},
                                       ensure_ascii=False), flush=True)
            stopped.wait()
    finally:
        if server is not None:
            server.shutdown()
        elif service is not None:
            close_reply_service(service)
        if thread is not None:
            thread.join(timeout=5)
            if thread.is_alive():
                raise RuntimeError('public_fixture_http_shutdown_incomplete')


if __name__ == '__main__':
    main()

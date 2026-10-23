"""真实loopback协议回归；只传合成owner，不访问数据库。"""
import json
import http.client
import threading
import time
from unittest.mock import patch
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from uuid import UUID

from notalone.persistence.skill_management_handoff import SkillManagementHandoff, SkillManagementUnavailable
from notalone.persistence.skill_management_remote import RemoteSkillManagement, SkillManagementRemoteUnavailable

OWNER = UUID('33333333-3333-3333-3333-333333333333')
TOKEN = 'synthetic-internal-token-0123456789'


class RemoteSkillManagementTest(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.payload = b'{"revision":7}'
        self.status = 200
        self.content_type = 'application/json'
        self.extra_headers = {}
        self.received = threading.Event()
        self.release = threading.Event()
        self.mode = 'normal'
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                outer.requests.append((self.path, self.headers.get('Authorization'),
                                       json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                outer.received.set()
                if outer.mode == 'blocked':
                    outer.release.wait(3)
                self.send_response(outer.status)
                self.send_header('Content-Type', outer.content_type)
                for key, value in outer.extra_headers.items():
                    self.send_header(key, value)
                self.send_header('Location', '/must-not-follow')
                self.end_headers()
                try:
                    if outer.mode == 'trickle':
                        for byte in outer.payload:
                            self.wfile.write(bytes([byte]))
                            self.wfile.flush()
                            if outer.release.wait(.04):
                                break
                    else:
                        self.wfile.write(outer.payload)
                except (OSError, ValueError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.remote = RemoteSkillManagement(port=self.server.server_port, internal_token=TOKEN, owner_id=OWNER)

    def tearDown(self):
        self.release.set()
        self.remote.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def test_fixed_identity_and_private_endpoint(self):
        self.assertEqual(self.remote.synchronize(), 7)
        self.assertEqual(self.requests, [('/api/runtime/skill-management/synchronize',
                                         f'Bearer {TOKEN}', {'owner_id': str(OWNER)})])


    def test_proxy_environment_is_ignored_and_scope_cannot_be_overridden(self):
        with patch.dict('os.environ', {'HTTP_PROXY': 'http://127.0.0.1:1',
                                      'http_proxy': 'http://127.0.0.1:1', 'ALL_PROXY': 'http://127.0.0.1:1',
                                      'NO_PROXY': '', 'no_proxy': ''}):
            self.assertEqual(self.remote.synchronize(), 7)
        with self.assertRaises(TypeError):
            self.remote.synchronize(owner_id=UUID(int=1))
        with self.assertRaises(TypeError):
            self.remote.synchronize(url='http://example.org')
        self.assertEqual(len(self.requests), 1)

    def test_redirect_auth_and_server_failures_are_single_attempts(self):
        for status in (301, 302, 307, 308, 401, 403, 409, 500, 503):
            with self.subTest(status=status):
                self.status = status
                self.payload = b'{"secret":"must-not-expose"}'
                before = len(self.requests)
                with self.assertRaisesRegex(SkillManagementRemoteUnavailable, '^skill_management_remote_unavailable$'):
                    self.remote.synchronize()
                self.assertEqual(len(self.requests), before + 1)

    def test_response_schema_utf8_duplicates_and_size_are_checked(self):
        for payload in (b'{"revision":true}', b'{"revision":-1}', b'{"revision":2147483648}',
                        b'{"revision":"7"}', b'{"revision":1.0}', b'[]', b'null',
                        b'{"revision":1,"revision":2}', b'{"revision":1,"extra":0}',
                        b'{"revision":', b'\xff', b' ' * 4096 + b'{"revision":1}'):
            with self.subTest(payload=payload[:50]):
                self.payload = payload
                with self.assertRaises(SkillManagementRemoteUnavailable):
                    self.remote.synchronize()
        for revision in (0, 2147483647):
            self.payload = json.dumps({'revision': revision}).encode()
            self.assertEqual(self.remote.synchronize(), revision)

    def test_response_framing_and_media_type_are_checked(self):
        for headers, media in (({'Content-Length': '100'}, 'application/json'),
                               ({'Content-Length': '5000'}, 'application/json'),
                               ({'Content-Encoding': 'gzip'}, 'application/json'),
                               ({}, 'text/html')):
            with self.subTest(headers=headers, media=media):
                self.extra_headers, self.content_type = headers, media
                with self.assertRaises(SkillManagementRemoteUnavailable):
                    self.remote.synchronize()

    def test_chunked_trailers_cannot_bypass_response_budget(self):
        self.extra_headers = {'Transfer-Encoding': 'chunked'}
        self.payload = b'e\r\n{"revision":7}\r\n0\r\nX-Extra: ' + b'x' * 32000 + b'\r\n\r\n'
        with self.assertRaises(SkillManagementRemoteUnavailable):
            self.remote.synchronize()

    def test_deadline_interrupts_waiting_for_response_headers(self):
        self.mode = 'blocked'
        remote = RemoteSkillManagement(port=self.server.server_port, internal_token=TOKEN,
                                       owner_id=OWNER, timeout_seconds=.2)
        start = time.monotonic()
        try:
            with self.assertRaises(SkillManagementRemoteUnavailable):
                remote.synchronize()
            self.assertLess(time.monotonic() - start, 1.5)
        finally:
            remote.close()

    def test_deadline_stops_trickling_body_even_without_socket_idle_timeout(self):
        self.mode = 'trickle'
        self.payload = b'{"revision":' + b' ' * 100 + b'7}'
        remote = RemoteSkillManagement(port=self.server.server_port, internal_token=TOKEN,
                                       owner_id=OWNER, timeout_seconds=.2)
        start = time.monotonic()
        try:
            with self.assertRaises(SkillManagementRemoteUnavailable):
                remote.synchronize()
            self.assertLess(time.monotonic() - start, 1.5)
            self.assertEqual(len(self.requests), 1)
        finally:
            remote.close()

    def test_close_interrupts_response_and_permanently_rejects_new_requests(self):
        self.mode = 'blocked'
        errors = []
        def run():
            try:
                self.remote.synchronize()
            except SkillManagementRemoteUnavailable as error:
                errors.append(str(error))
        worker = threading.Thread(target=run)
        worker.start()
        self.assertTrue(self.received.wait(1))
        self.remote.close()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, ['skill_management_remote_unavailable'])
        with self.assertRaises(SkillManagementRemoteUnavailable):
            self.remote.synchronize()
        self.assertEqual(len(self.requests), 1)

    def test_cancellation_before_send_cannot_reopen_connection(self):
        for by_timeout in (False, True):
            with self.subTest(by_timeout=by_timeout):
                entered, proceed, closed = threading.Event(), threading.Event(), threading.Event()
                original_request = http.client.HTTPConnection.request
                original_close = http.client.HTTPConnection.close
                remote = RemoteSkillManagement(port=self.server.server_port, internal_token=TOKEN,
                                               owner_id=OWNER, timeout_seconds=.2 if by_timeout else 10)
                errors = []
                def paused_request(connection, *args, **kwargs):
                    entered.set()
                    if not proceed.wait(2):
                        raise RuntimeError('测试未释放发送')
                    return original_request(connection, *args, **kwargs)
                def observed_close(connection):
                    original_close(connection)
                    closed.set()
                def run():
                    try:
                        remote.synchronize()
                    except SkillManagementRemoteUnavailable:
                        errors.append('cancelled')
                worker = threading.Thread(target=run)
                try:
                    with patch.object(http.client.HTTPConnection, 'request', paused_request), \
                         patch.object(http.client.HTTPConnection, 'close', observed_close):
                        worker.start()
                        self.assertTrue(entered.wait(1))
                        if not by_timeout:
                            remote.close()
                        self.assertTrue(closed.wait(1))
                        proceed.set()
                        worker.join(1)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(errors, ['cancelled'])
                    self.assertEqual(self.requests, [])
                finally:
                    proceed.set()
                    remote.close()
                    worker.join(2)

    def test_handoff_uses_bound_remote_and_never_reverts_on_failure(self):
        gate = SkillManagementHandoff()
        gate.stop()
        gate.activate(owner_id=OWNER, synchronize=self.remote.synchronize)
        self.assertEqual(gate.synchronize(OWNER, lambda: self.fail('不得本地同步')), 7)
        self.status = 503
        with self.assertRaises(SkillManagementUnavailable):
            gate.synchronize(OWNER, lambda: self.fail('远端失败不得回退'))
        with self.assertRaises(SkillManagementUnavailable):
            gate.synchronize(UUID(int=1), lambda: self.fail('身份不匹配不得回退'))
        self.assertEqual(len(self.requests), 2)

    def test_invalid_configuration_never_opens_a_connection(self):
        base = dict(port=self.server.server_port, internal_token=TOKEN, owner_id=OWNER)
        for override in ({'port': True}, {'port': 0}, {'port': 65536}, {'port': '80'},
                         {'owner_id': str(OWNER)}, {'internal_token': 'short'},
                         {'internal_token': TOKEN + '\r\n'}, {'internal_token': 'x' * 1025},
                         {'timeout_seconds': True}, {'timeout_seconds': float('nan')},
                         {'timeout_seconds': float('inf')}, {'timeout_seconds': 0},
                         {'timeout_seconds': 31}):
            with self.subTest(override=override):
                with self.assertRaises(ValueError):
                    RemoteSkillManagement(**{**base, **override})
        self.assertEqual(self.requests, [])

if __name__ == '__main__':
    unittest.main()

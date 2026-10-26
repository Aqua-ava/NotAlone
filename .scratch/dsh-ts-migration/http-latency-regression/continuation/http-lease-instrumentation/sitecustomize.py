"""仅本轮合成宿主的 HTTP／驱动边界观察及出站拒绝。"""
import json
import os
import socket
import threading
import time

_trace_path = os.environ.get('NOTALONE_PERF_TRACE')
if _trace_path:
    def _record(value):
        value['pid'] = os.getpid()
        with open(_trace_path, 'a') as stream:
            stream.write(json.dumps(value) + '\n')

    _connect = socket.socket.connect
    _getaddrinfo = socket.getaddrinfo

    def _safe_connect(sock, address):
        allowed = (isinstance(address, tuple) and address[0] == '127.0.0.1') or (
            isinstance(address, str) and (address == '/tmp/.s.PGSQL.5432' or
            address.startswith(('/tmp/na-model-', '/private/tmp/na-model-'))))
        if not allowed:
            _record({'type': 'network_denied'})
            raise OSError('host_performance_network_denied')
        return _connect(sock, address)

    def _safe_resolve(host, *args, **kwargs):
        if host not in ('127.0.0.1', None):
            _record({'type': 'network_denied'})
            raise OSError('host_performance_dns_denied')
        return _getaddrinfo(host, *args, **kwargs)

    socket.socket.connect = _safe_connect
    socket.getaddrinfo = _safe_resolve
    _local = threading.local()
    import http.server
    _handle = http.server.BaseHTTPRequestHandler.handle_one_request
    _parse = http.server.BaseHTTPRequestHandler.parse_request

    def _timed_parse(handler):
        valid = _parse(handler)
        context = getattr(_local, 'context', None)
        if valid and context is not None:
            # 与 Node request 事件对齐：请求头解析完成、进入业务处理器。
            context['start'] = time.monotonic_ns()
        return valid

    http.server.BaseHTTPRequestHandler.parse_request = _timed_parse

    def _timed_handle(handler):
        context = {'start': time.monotonic_ns(), 'commits': [], 'first_sql': None}
        _local.context = context
        handler.requestline = ''
        try:
            return _handle(handler)
        finally:
            headers = getattr(handler, 'headers', {})
            request_id = headers.get('X-NotAlone-Perf-Id', '')
            if request_id and handler.requestline:
                start = context['start']
                _record({'type': 'http', 'request_id': request_id,
                         'ingress_ns': start,
                         'persistence_complete_ns': context['commits'][-1] if context['commits'] else None,
                         'server_response_ms': (time.monotonic_ns()-start)/1e6,
                         'persistence_complete_ms': (context['commits'][-1]-start)/1e6 if context['commits'] else None,
                         'transaction_ms': sum(context.get('transactions', [])) if context['commits'] else None,
                         'queue_ms': None})
            _local.context = None

    http.server.BaseHTTPRequestHandler.handle_one_request = _timed_handle

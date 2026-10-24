"""仅在自有临时 Legacy project 生效；模型回退与非本机运输立即失败。"""
import json
import os
from pathlib import Path
import socket

_audit = Path(os.environ['NOTALONE_SYNTHETIC_RUNTIME_AUDIT'])
_runtime = {key: os.environ.get(key) for key in (
    'NOTALONE_REPLY_REMOTE_TOKEN', 'NOTALONE_REPLY_REMOTE_URL',
    'NOTALONE_MODEL_PERMIT_SOCKET', 'NOTALONE_OWNER_ID',
)}
_connect = socket.socket.connect
_resolve = socket.getaddrinfo


def _blocked(*args, **kwargs):
    marker = Path(os.environ['NOTALONE_SYNTHETIC_FALLBACK_AUDIT'])
    marker.write_text('blocked\n')
    marker.chmod(0o600)
    raise AssertionError('synthetic_python_model_fallback_forbidden')


def _local_connect(self, address):
    if isinstance(address, tuple):
        if address[0] not in ('127.0.0.1', '::1'):
            raise AssertionError('synthetic_python_external_socket_forbidden')
    elif address not in (os.environ.get('NOTALONE_MODEL_PERMIT_SOCKET'), '/tmp/.s.PGSQL.5432'):
        raise AssertionError('synthetic_python_unix_socket_forbidden')
    return _connect(self, address)


def _local_resolve(host, *args, **kwargs):
    if host not in ('127.0.0.1', '::1', 'localhost', None):
        raise AssertionError('synthetic_python_external_dns_forbidden')
    return _resolve(host, *args, **kwargs)


socket.socket.connect = _local_connect
socket.getaddrinfo = _local_resolve
from langchain_deepseek import ChatDeepSeek
for _method in ('_generate', '_agenerate', '_stream', '_astream'):
    setattr(ChatDeepSeek, _method, _blocked)
_runtime['python_model_guard_installed'] = True
_audit.write_text(json.dumps(_runtime))
_audit.chmod(0o600)

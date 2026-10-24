"""测试专用连接门禁；不替换任何业务函数/SDK或资格校验。"""
import socket
_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex

def _allowed(address):
    if isinstance(address, str):
        return address == '/tmp/.s.PGSQL.5432' or address.startswith(('/tmp/na-model-', '/private/tmp/na-model-')) and address.endswith('/p.sock')
    return isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1')

def _connect(self, address):
    if not _allowed(address):
        raise RuntimeError('synthetic_python_network_denied')
    return _original_connect(self, address)

def _connect_ex(self, address):
    if not _allowed(address):
        raise RuntimeError('synthetic_python_network_denied')
    return _original_connect_ex(self, address)
socket.socket.connect = _connect
socket.socket.connect_ex = _connect_ex
_original_getaddrinfo = socket.getaddrinfo
def _getaddrinfo(host, *args, **kwargs):
    if host not in ('127.0.0.1', '::1', None):
        raise RuntimeError('synthetic_python_dns_denied')
    return _original_getaddrinfo(host, *args, **kwargs)
socket.getaddrinfo = _getaddrinfo

# 仅在隔离Legacy启动时捕获允许列表；私有桥token只留本轮0700目录下的0600文件。
import json
import os
_bridge_file = os.environ.get("NOTALONE_SYNTHETIC_EXTRACTION_BRIDGE_FILE")
if _bridge_file:
    try:
        _descriptor = os.open(_bridge_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(_descriptor, "w") as _capture:
            json.dump({key: os.environ[key] for key in (
                "NOTALONE_MODEL_PERMIT_SOCKET", "NOTALONE_MODEL_PERMIT_TOKEN",
                "NOTALONE_EXTRACTION_RUNTIME", "NOTALONE_EXTRACTION_B_RUNTIME",
                "NOTALONE_TASK_WORKER_RUNTIME",
                "NOTALONE_EXTRACTION_REMOTE_URL",
                "NOTALONE_EXTRACTION_REMOTE_TOKEN", "NOTALONE_REPLY_RUNTIME",
                "NOTALONE_OWNER_ID",
            ) if key in os.environ}, _capture)

"""仅用于合成本机Legacy子进程；拒绝外网且记录纯计数，不含请求资料。"""
import os
from pathlib import Path
import socket

_connect = socket.socket.connect
_resolve = socket.getaddrinfo

def _reject():
    Path(os.environ['NOTALONE_SYNTHETIC_NETWORK_AUDIT']).write_text('blocked\n')
    raise RuntimeError('external_network_forbidden')

def _local_connect(self, address):
    if isinstance(address, tuple):
        if address[0] not in ('127.0.0.1', '::1'):
            _reject()
    elif address not in (os.environ.get('NOTALONE_MODEL_PERMIT_SOCKET'), '/tmp/.s.PGSQL.5432'):
        _reject()
    return _connect(self, address)

def _local_resolve(host, *args, **kwargs):
    if host not in ('127.0.0.1', '::1', None):
        _reject()
    return _resolve(host, *args, **kwargs)

socket.socket.connect = _local_connect
socket.getaddrinfo = _local_resolve

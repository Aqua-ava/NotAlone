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

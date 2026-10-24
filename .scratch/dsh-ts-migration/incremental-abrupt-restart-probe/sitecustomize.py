"""本轮Legacy进程传输审计，不替换业务对象。"""
import json,os,socket
_log=os.environ.get('NOTALONE_SYNTHETIC_NETWORK_AUDIT')
def _record(event):
 if _log:
  with open(_log,'a') as f:f.write(json.dumps({'pid':os.getpid(),**event})+'\n')
_record({'type':'guard_load'})
_original_connect=socket.socket.connect
_original_connect_ex=socket.socket.connect_ex
def _check(address):
 target=address[0] if isinstance(address,tuple) else address
 allowed=isinstance(target,str) and (target.startswith('/') or target in ['localhost','127.0.0.1','::1'])
 _record({'type':'local_connect' if allowed else 'external_attempt','target':str(target)})
 if not allowed:raise RuntimeError('合成验收禁止外网连接')
def _connect(self,address):_check(address);return _original_connect(self,address)
def _connect_ex(self,address):_check(address);return _original_connect_ex(self,address)
socket.socket.connect=_connect;socket.socket.connect_ex=_connect_ex

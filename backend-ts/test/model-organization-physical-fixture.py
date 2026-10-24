"""真实ChatDeepSeek同步调用；仅合成loopback与私有许可socket。"""
import json,sys
from uuid import UUID
from types import SimpleNamespace
import httpx
from langchain_deepseek import ChatDeepSeek
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.application.model_transport_accounting import PhysicalModelScope
from notalone.memory.organization_quality_transport import OrganizationQualityHTTPTransport,organization_request_context
config=json.loads(sys.stdin.readline())
control=SharedModelPriorityControl(socket_path=config['socket'],token=config['token'])
scope=PhysicalModelScope(control,UUID(config['task']),UUID(config['owner']),UUID(config['contact']) if config['contact'] else None,
 'contact' if config['contact'] else 'owner_memory','deepseek','synthetic-model',claim=config['claim'])
http=httpx.Client(transport=OrganizationQualityHTTPTransport())
model=ChatDeepSeek(model='synthetic-model',api_key='synthetic',base_url=config['url'],max_retries=0,http_client=http,timeout=3)
results=[]
try:
 for i in range(2):
  try:
   with control.background_call(),organization_request_context(lambda:None,lambda *a:None,
       SimpleNamespace(check=lambda:None,remaining_seconds=lambda:3),SimpleNamespace(max_characters=10000),accounting_scope=scope):
    model.invoke([{'role':'user','content':'合成'}]);results.append('ok')
  except Exception as e:results.append(type(e).__name__)
 print(json.dumps({'results':results}),flush=True)
finally:http.close()

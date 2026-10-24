"""原组织transport/共享许可/真实ChatDeepSeek SDK；单次有界合成业务调用。"""
import json
import sys
from types import SimpleNamespace
from uuid import UUID

# 与主宿主夹具相同的出站前门禁；不替换SDK或业务资格函数。
import sitecustomize  # noqa: F401
import httpx
from langchain_deepseek import ChatDeepSeek
from notalone.application.model_permit_client import SharedModelPriorityControl
from notalone.application.model_transport_accounting import PhysicalModelScope
from notalone.memory.organization_quality_transport import (
    OrganizationQualityHTTPTransport, organization_request_context,
)

config = json.loads(sys.stdin.readline())
control = SharedModelPriorityControl(socket_path=config['socket'], token=config['token'])
scope = PhysicalModelScope(
    control, UUID(config['task']), UUID(config['owner']), UUID(config['contact']),
    'contact', 'deepseek', 'deepseek-flash', claim=config['claim'],
)
http = httpx.Client(transport=OrganizationQualityHTTPTransport())
model = ChatDeepSeek(model='deepseek-flash', api_key='synthetic-only',
                    base_url=config['url'], max_retries=0, http_client=http, timeout=15)
try:
    with control.background_call(), organization_request_context(
        lambda: None, lambda *args: None,
        SimpleNamespace(check=lambda: None, remaining_seconds=lambda: 15),
        SimpleNamespace(max_characters=10000), accounting_scope=scope,
    ):
        result = model.invoke([{'role': 'user', 'content': config['label']}])
    print(json.dumps({'ok': result.content == '合成整理完成', 'sdk_max_retries': model.max_retries}), flush=True)
finally:
    http.close()

"""仅在隔离验收包内作为 sitecustomize 使用的合成模型传输。

不改产品装配、控制器、联系人或数据库。HTTPX 0.28.1 / HTTPX2 2.13.1 的公开 MockTransport
截断模型请求，并以socket护栏独立阻止外部连接；只接受测试在公开设置界面输入的固定合成密钥。
正式 prepare-runtime 不会复制本文件，验收包不能充作真实模型或发行证据。
"""

import json
import ipaddress
import socket
import os
from pathlib import Path
import threading
import time
from uuid import uuid4

import httpx
try:
    import httpx2
except ImportError:
    httpx2 = None

_lock = threading.Lock()
_calls = 0
_failures = 0


def respond(request, library=httpx):
    global _calls, _failures
    if (request.url.host != "api.deepseek.com" or not request.url.path.endswith("/chat/completions")
            or request.headers.get("authorization") not in {
                "Bearer synthetic-manual-package-not-a-real-key", "Bearer synthetic-manual-official-recovery-not-a-real-key"}):
        return library.Response(401, json={"error": {"message": "synthetic_transport_scope_rejected"}})
    payload = json.loads(request.content)
    if payload.get("model") != "deepseek-flash" or payload.get("reasoning_effort") != "none":
        return library.Response(400, json={"error": {"message": "synthetic_model_contract_rejected"}})
    inputs = []
    for message in payload["messages"]:
        if message["role"] != "user" or not isinstance(message.get("content"), str):
            continue
        try:
            value = json.loads(message["content"])
            if isinstance(value, dict) and "input_mode" in value:
                inputs.append(value)
        except ValueError:
            continue
    current = inputs[-1]
    evidence = next(item for item in current["evidence"]
                    if item["kind"] in ("user_current_chat", "user_draft", "message", "user_purpose"))
    marker = "乙" if "合成乙" in evidence["text"] else "甲"
    with _lock:
        _calls += 1
        failed = "合成模型故障" in evidence["text"] and _failures < 3
        if failed:
            _failures += 1
        home = Path(os.environ["HOME"])
        if home.name.startswith("notalone-app-"):
            # 仅固定分类和次数，不写正文、联系人名称、提示词或密钥。
            audit = {"calls": _calls, "failures": _failures, "last_mode": current["input_mode"],
                     "last_evidence_kind": evidence["kind"], "network": "mock-only", "network_guard": True}
            file = home / "synthetic-model-audit.json"
            file.write_text(json.dumps(audit), encoding="utf-8")
            file.chmod(0o600)
    if failed:
        return library.Response(503, json={"error": {"message": "synthetic_unavailable"}})
    time.sleep(0.25)
    result = {"candidates": [{"text": f"合成{marker}，我知道了，我们晚点再确认。",
                              "basis": "依据本次明确提供的文字和表达方向。",
                              "citation_ids": [evidence["evidence_id"]], "risk_notes": []},
                             {"text": f"合成{marker}，收到，稍后再联系。",
                              "basis": "保留本次明确方向，没有增加承诺。",
                              "citation_ids": [evidence["evidence_id"]], "risk_notes": []}],
              "used_skill_version_id": None}
    return library.Response(200, json={"id": f"synthetic-{uuid4()}", "object": "chat.completion",
        "created": 1, "model": "deepseek-flash", "choices": [{"index": 0, "finish_reason": "tool_calls",
        "message": {"role": "assistant", "content": "", "tool_calls": [{"id": f"call-{uuid4()}",
        "type": "function", "function": {"name": "ReplyRuntimeOutput", "arguments": json.dumps(result, ensure_ascii=False)}}]}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}})


def guarded_init(original, library):
    def initialize(client, *args, **kwargs):
        # 这是验收解释器内唯一替换点，所有HTTPX请求均无法落入真实网络。
        kwargs.update(transport=library.MockTransport(lambda request: respond(request, library)), mounts={}, trust_env=False)
        return original(client, *args, **kwargs)
    return initialize


for library in (httpx, httpx2):
    if library is not None:
        library.Client.__init__ = guarded_init(library.Client.__init__, library)
        library.AsyncClient.__init__ = guarded_init(library.AsyncClient.__init__, library)

# SDK 可能改用另一HTTP库；独立网络护栏在传输失配时仍阻止所有外部连接。
_original_connect, _original_connect_ex = socket.socket.connect, socket.socket.connect_ex
_original_resolve = socket.getaddrinfo

def loopback_only(address):
    if isinstance(address, str) and address.startswith("/"):
        return
    try:
        if isinstance(address, tuple) and ipaddress.ip_address(address[0]).is_loopback:
            return
    except ValueError:
        pass
    raise RuntimeError("synthetic_external_network_blocked")

def guarded_connect(stream, address):
    loopback_only(address)
    return _original_connect(stream, address)

def guarded_connect_ex(stream, address):
    loopback_only(address)
    return _original_connect_ex(stream, address)

def guarded_resolve(host, *args, **kwargs):
    if host not in (None, "localhost", "127.0.0.1", "::1", b"127.0.0.1"):
        raise RuntimeError("synthetic_external_network_blocked")
    return _original_resolve(host, *args, **kwargs)

socket.socket.connect, socket.socket.connect_ex = guarded_connect, guarded_connect_ex
socket.getaddrinfo = guarded_resolve
NETWORK_GUARD_INSTALLED = True
home = Path(os.environ.get("HOME", ""))
if home.name.startswith("notalone-app-"):
    file = home / "synthetic-model-audit.json"
    file.write_text(json.dumps({"calls": 0, "network": "mock-only", "network_guard": True}), encoding="utf-8")
    file.chmod(0o600)


def assert_sdk_canary():
    """每次验收启动前通过同包解释器确认实际SDK命中Mock和独立网络护栏。"""
    from notalone.reply.adapters.deepseek_provider import build_deepseek_model
    try:
        socket.socket().connect(("203.0.113.1", 443))
    except RuntimeError as error:
        assert str(error) == "synthetic_external_network_blocked"
    else:
        raise AssertionError("synthetic_network_guard_missing")
    model = build_deepseek_model(api_key="synthetic-manual-package-not-a-real-key")
    result = model.invoke([{"role": "user", "content": json.dumps({
        "input_mode": "reply_to_pasted_text", "evidence": [{"kind": "user_current_chat",
        "text": "合成甲", "evidence_id": str(uuid4())}]})}])
    assert len(result.tool_calls) == 1 and _calls == 1
    print("synthetic_sdk_canary_passed")

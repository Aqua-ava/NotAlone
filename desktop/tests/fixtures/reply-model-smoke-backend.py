"""单次合成草稿的验收专用装配；默认拒绝真实预算与凭据读取。"""

from __future__ import annotations

import hashlib
from asyncio import CancelledError
from importlib.metadata import version
import json
import os
from pathlib import Path
import shlex
import stat
import sys
from threading import Lock
from unittest.mock import patch
from uuid import UUID, uuid4

import httpx
from langchain_core.utils.function_calling import convert_to_openai_tool
from langchain_deepseek import ChatDeepSeek

from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationAsyncTransport, EvaluationBudget, EvaluationBudgetAbort, EvaluationTransport,
)
from notalone.reply.adapters.async_runner import run_with_timeout
from notalone.reply.adapters import langchain_runtime as runtime
from notalone.reply.adapters.langchain_runtime import LangChainReplyRuntime, REPLY_RUNTIME_SCHEMA
from notalone.reply.input_budget import (
    InputBudgetProfile, InputBudgetRequest, InputComponent, InputTokenMeasurement, TokenMeasurementKind,
)

ROOT = Path(__file__).resolve().parents[3]
PROJECT_ENV = ROOT / ".env"
MODEL = "deepseek-flash"
BASE_URL = "https://api.deepseek.com"
ENDPOINT = BASE_URL + "/chat/completions"
DRAFT = "明天我有空，晚点见。"
INSTRUCTION = "更自然一点，保留原意，不添加新事实。"
OUTPUT_RESERVE = 2048
MAX_JSON_BYTES = 32768
MEASUREMENT_ID = "deepseek-flash-smoke-chat-json-byte-estimate-v1"
_PAYLOAD_FIELDS = frozenset({
    "model", "messages", "tools", "tool_choice", "max_tokens", "temperature", "stream", "reasoning_effort",
})


def canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def expected_tools():
    # 只构造公开schema，不运行读取handler或发现任何Skill。
    read_file = runtime._create_read_file_tool(skill_port=None, scope=None, entries={})
    return [convert_to_openai_tool(read_file), convert_to_openai_tool(REPLY_RUNTIME_SCHEMA)]


def expected_system_messages():
    middleware = runtime.SkillsMiddleware(
        backend=None, sources=[(f"{runtime.SKILL_SOURCE}/", "NotAlone")], system_prompt=runtime.NOTALONE_SKILLS_PROMPT,
    )
    section = runtime.NOTALONE_SKILLS_PROMPT.format(
        skills_locations=middleware._format_skills_locations(),
        skills_list=middleware._format_skills_list([]),
        skills_load_warnings=middleware._format_skills_load_warnings([]),
    )
    return [base + "\n\n" + section for base in (
        runtime.BASE_SYSTEM_PROMPT, runtime.BASE_SYSTEM_PROMPT + "\n" + runtime.DISCUSSION_HISTORY_NOTICE,
    )]


def configuration(app_asar_sha256: str | None = None) -> dict:
    sources = (
        "backend/src/notalone/server/reply_wiring.py",
        "backend/src/notalone/reply/adapters/langchain_runtime.py",
        "backend/src/notalone/reply/adapters/input_budget_middleware.py",
        "backend/src/notalone/reply/input_budget.py",
        "backend/src/notalone/reply/fidelity.py",
        "backend/src/notalone/reply/assistant_discussion.py",
        "backend/src/notalone/memory_extraction/evaluation_http_budget.py",
        "desktop/tests/fixtures/reply-model-smoke-backend.py",
        "desktop/tests/reply-model-smoke-fixture.ts",
        "desktop/tests/reply-model-smoke-app-acceptance.spec.ts",
    )
    return {
        "purpose": "synthetic-app-rewrite-smoke", "model": MODEL, "endpoint": ENDPOINT,
        "max_retries": 0, "request_limit": 1, "reasoning_effort": "none", "stream": False,
        "output_reserve": OUTPUT_RESERVE, "effective_window": 65536, "safety_margin": 16384,
        "framing_estimate": 4096, "measurement": "approximate", "max_json_bytes": MAX_JSON_BYTES,
        "draft_sha256": hashlib.sha256(canonical([DRAFT, INSTRUCTION, False])).hexdigest(),
        "schema_sha256": hashlib.sha256(canonical(REPLY_RUNTIME_SCHEMA)).hexdigest(),
        "complete_tool_schemas_sha256": hashlib.sha256(canonical(expected_tools())).hexdigest(),
        "system_prompts_sha256": hashlib.sha256(canonical(expected_system_messages())).hexdigest(),
        "app_asar_sha256": app_asar_sha256,
        "credential_formats": ["private-single-line-key-v1", "explicit-project-provider-env-v1"],
        "versions": {name: version(name) for name in ("langchain", "langchain-deepseek", "langchain-openai", "deepagents", "openai", "httpx")},
        "sources": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources},
    }


def configuration_sha256(app_asar_sha256: str | None = None) -> str:
    return hashlib.sha256(canonical(configuration(app_asar_sha256))).hexdigest()


def require_live_configuration(environment) -> tuple[UUID, Path, str]:
    # 必须先检查非秘密授权参数，不能因为机器上有key就自动执行。
    if environment.get("NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE") != "1":
        raise ValueError("smoke_not_enabled")
    try:
        run_id = UUID(environment["NOTALONE_REPLY_MODEL_SMOKE_AUTHORIZED_RUN_ID"])
        asar = environment["NOTALONE_REPLY_MODEL_SMOKE_APP_ASAR_SHA256"]
        if len(asar) != 64 or any(c not in "0123456789abcdef" for c in asar):
            raise ValueError()
        expected = configuration_sha256(asar)
        if environment["NOTALONE_REPLY_MODEL_SMOKE_CONFIG_SHA256"] != expected:
            raise ValueError()
        key_file = Path(environment["NOTALONE_REPLY_MODEL_SMOKE_KEY_FILE"])
        if (not key_file.is_absolute()
                or key_file.name.startswith(".env") and key_file != PROJECT_ENV):
            raise ValueError()
        identity = key_file.lstat()
        if (not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid()
                or identity.st_mode & 0o077 or identity.st_size > (16384 if key_file == PROJECT_ENV else 1024)):
            raise ValueError()
    except (KeyError, ValueError, OSError):
        raise ValueError("smoke_authorization_or_freeze_invalid") from None
    return run_id, key_file, expected


def input_profile() -> InputBudgetProfile:
    # 这是本场主动收窄的有效窗口；字节估算不是官方tokenizer或上界。
    return InputBudgetProfile(
        model_id=MODEL, context_window_tokens=65536, output_reserve_tokens=OUTPUT_RESERVE,
        warning_ratio=0.8, measurement_kind=TokenMeasurementKind.APPROXIMATE,
        measurement_id=MEASUREMENT_ID, safety_margin_tokens=16384,
    )


def require_payload(payload: dict) -> None:
    if (not isinstance(payload, dict) or set(payload) - _PAYLOAD_FIELDS
            or len(canonical(payload)) > MAX_JSON_BYTES
            or payload.get("model") != MODEL or payload.get("reasoning_effort") != "none"
            or payload.get("max_tokens") != OUTPUT_RESERVE or payload.get("temperature") != 0
            or payload.get("stream") is not False or payload.get("tool_choice") != "required"):
        raise ValueError("smoke_request_contract_invalid")
    tools = payload.get("tools")
    if not isinstance(tools, list) or {item.get("function", {}).get("name") for item in tools} != {"read_file", "ReplyRuntimeOutput"} or len(tools) != 2:
        raise ValueError("smoke_tool_contract_invalid")
    if sorted(tools, key=lambda item: item["function"]["name"]) != sorted(expected_tools(), key=lambda item: item["function"]["name"]):
        raise ValueError("smoke_tool_schema_changed")
    messages = payload.get("messages")
    if not isinstance(messages, list) or len(messages) != 2 or [m.get("role") for m in messages] != ["system", "user"]:
        # 包括业务工具后的第二轮；本场不接受历史或多轮。
        raise ValueError("smoke_single_turn_only")
    if messages[0].get("content") not in expected_system_messages():
        raise ValueError("smoke_system_prompt_changed")
    content = json.loads(messages[1]["content"])
    if (content.get("input_mode") != "rewrite_draft" or content.get("draft_text") != DRAFT
            or content.get("user_instruction") != INSTRUCTION or content.get("include_relationship_context") is not False
            or content.get("style_references") != [] or content.get("skill_selection") != {"mode": "auto"}
            or [item.get("kind") for item in content.get("evidence", [])] != ["user_draft"]
            or content["evidence"][0].get("text") != DRAFT):
        raise ValueError("smoke_synthetic_scope_invalid")


class SmokeAudit:
    def __init__(self, path=None):
        self.lock = Lock()
        self.path = path
        self.responses = 0
        self.last_request = None
        self.measured_sha256 = None
        self.response_model_matches = False
        self.failure_kind = None
        self.status_codes = []

    def persist(self):
        if self.path is not None:
            temporary = self.path.with_suffix(".tmp")
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w") as record:
                json.dump(self.metadata(), record)
                record.flush()
                os.fsync(record.fileno())
            os.replace(temporary, self.path)

    def before(self, budget, request):
        try:
            if request.method != "POST" or str(request.url) != ENDPOINT or len(request.content) > MAX_JSON_BYTES:
                raise ValueError()
            payload = json.loads(request.content)
            require_payload(payload)
            with self.lock:
                if hashlib.sha256(canonical(payload)).hexdigest() != self.measured_sha256:
                    raise ValueError("smoke_measured_payload_changed")
                self.last_request = payload
                self.persist()
        except Exception:
            budget.close()
            raise EvaluationBudgetAbort("smoke_outbound_contract_invalid") from None

    def response(self, budget, response):
        with self.lock:
            self.responses += 1
            self.status_codes.append(response.status_code)
        if response.is_success:
            try:
                self.response_model_matches = response.json().get("model") == MODEL
            except ValueError:
                self.response_model_matches = False
            if not self.response_model_matches:
                self.failure_kind = "response_model_mismatch"
                self.persist()
                budget.close()
                raise EvaluationBudgetAbort("smoke_response_model_mismatch")
        else:
            self.failure_kind = "provider_http_error"
            budget.close()
        self.persist()

    def failed(self, error):
        if self.failure_kind is None:
            self.failure_kind = ("cancelled" if isinstance(error, CancelledError) else
                                 "timeout" if isinstance(error, httpx.TimeoutException) else
                                 "transport_error" if isinstance(error, httpx.TransportError) else "budget_or_contract_abort")
        self.persist()

    def metadata(self):
        return {"responses": self.responses, "response_model_matches": self.response_model_matches,
                "status_codes": self.status_codes, "failure_kind": self.failure_kind,
                "request_model": MODEL, "reasoning_effort": "none", "endpoint": ENDPOINT,
                "measured_request_sha256": self.measured_sha256,
                "request_sha256": hashlib.sha256(canonical(self.last_request)).hexdigest() if self.last_request else None}


class GuardedSyncTransport(httpx.BaseTransport):
    def __init__(self, budget, audit, synthetic):
        self.budget, self.audit = budget, audit
        self.delegate = EvaluationTransport(budget, synthetic_transport=synthetic)

    def handle_request(self, request):
        try:
            self.audit.before(self.budget, request)
            response = self.delegate.handle_request(request)
            self.audit.response(self.budget, response)
            return response
        except BaseException as error:
            preserve_abort(self.budget, self.audit, error)
            raise

    def close(self):
        self.delegate.close()


class GuardedAsyncTransport(httpx.AsyncBaseTransport):
    def __init__(self, budget, audit, synthetic):
        self.budget, self.audit = budget, audit
        self.delegate = EvaluationAsyncTransport(budget, synthetic_transport=synthetic)

    async def handle_async_request(self, request):
        try:
            self.audit.before(self.budget, request)
            response = await self.delegate.handle_async_request(request)
            self.audit.response(self.budget, response)
            return response
        except BaseException as error:
            preserve_abort(self.budget, self.audit, error)
            raise

    async def aclose(self):
        await self.delegate.aclose()


def preserve_abort(budget, audit, error):
    try:
        budget.close()
    except BaseException:
        error.add_note("smoke_budget_close_unconfirmed")
    try:
        audit.failed(error)
    except BaseException:
        error.add_note("smoke_audit_write_failed")


class SmokeCounter:
    def __init__(self, bundle):
        self.bundle = bundle
        self.bound = self._identity()

    def _identity(self):
        model, sync, asynchronous = self.bundle.model, self.bundle.sync_client, self.bundle.async_client
        if (type(model) is not SmokeDeepSeek or model.model_name != MODEL or model.max_retries != 0
                or model.http_client is not sync or model.http_async_client is not asynchronous
                or sync._transport is not self.bundle.sync_transport or asynchronous._transport is not self.bundle.async_transport
                or model.root_client._client is not sync or model.root_async_client._client is not asynchronous
                or model.client._client is not model.root_client or model.async_client._client is not model.root_async_client
                or any(str(root.base_url).rstrip("/") != BASE_URL or root.max_retries != 0
                       for root in (model.root_client, model.root_async_client))):
            raise ValueError("smoke_model_binding_invalid")
        return canonical(model._get_request_payload([]))

    def is_bound_to(self, model):
        try:
            return model is self.bundle.model and self._identity() == self.bound
        except (ValueError, TypeError, AttributeError):
            return False

    def measure(self, request: InputBudgetRequest):
        if not self.is_bound_to(self.bundle.model) or request.model_id != MODEL:
            raise ValueError("smoke_counter_binding_invalid")
        payload = {**request.model_settings, "model": request.model_id,
                   "messages": ([dict(request.system_message)] if request.system_message else []) + list(request.messages)}
        if request.tool_schemas:
            payload["tools"] = list(request.tool_schemas)
        if request.response_schema is not None:
            payload["response_format"] = dict(request.response_schema)
        require_payload(payload)
        with self.bundle.audit.lock:
            self.bundle.audit.measured_sha256 = hashlib.sha256(canonical(payload)).hexdigest()
        return InputTokenMeasurement(
            model_id=MODEL, input_tokens=len(canonical(payload)) + 4096,
            kind=TokenMeasurementKind.APPROXIMATE, measurement_id=MEASUREMENT_ID,
            covered_components=frozenset(InputComponent),
        )


class SmokeDeepSeek(ChatDeepSeek):
    """本场序列化适配：仅将纯文字system块无损拼接为官方要求的string。

    不改变生产默认模型构造；非文字或未知块不作静默转换。
    """

    def _get_request_payload(self, *args, **kwargs):
        payload = super()._get_request_payload(*args, **kwargs)
        for message in payload["messages"]:
            if message["role"] != "system":
                continue
            content = message["content"]
            if not isinstance(content, list) or len(content) != 2 or any(
                not isinstance(block, dict) or set(block) != {"type", "text"}
                or block["type"] != "text" or not isinstance(block["text"], str)
                for block in content
            ):
                raise ValueError("smoke_system_text_only")
            if not content[1]["text"].startswith("\n\n"):
                raise ValueError("smoke_system_separator_changed")
            # 生产第二块已有这两个换行；移除再以唯一分隔符连接，最终字节无损。
            message["content"] = "\n\n".join((content[0]["text"], content[1]["text"][2:]))
        return payload


class SmokeModel:
    def __init__(self, budget, api_key, *, synthetic_transport=None, audit_path=None):
        self.budget = budget
        self.audit = SmokeAudit(audit_path)
        self.sync_transport = GuardedSyncTransport(budget, self.audit, synthetic_transport)
        self.async_transport = GuardedAsyncTransport(budget, self.audit, synthetic_transport)
        self.sync_client = httpx.Client(transport=self.sync_transport, trust_env=False, follow_redirects=False, timeout=20)
        self.async_client = httpx.AsyncClient(transport=self.async_transport, trust_env=False, follow_redirects=False, timeout=20)
        self.model = SmokeDeepSeek(
            model=MODEL, api_key=api_key, base_url=BASE_URL, max_retries=0,
            timeout=20, temperature=0, streaming=False, reasoning_effort="none",
            http_client=self.sync_client, http_async_client=self.async_client,
        )
        self.counter = SmokeCounter(self)

    def close(self):
        self.sync_client.close()
        run_with_timeout(self.async_client.aclose(), seconds=3)


def mock_response(request, *, tool_loop=False, invalid=False, model=MODEL):
    content = json.loads(json.loads(request.content)["messages"][-1]["content"])
    args = {"candidates": [{"text": "明天有空，晚点见。", "basis": "仅润色本次草稿。",
                            "citation_ids": [content["evidence"][0]["evidence_id"]], "risk_notes": []}],
            "used_skill_version_id": None}
    name = "ReplyRuntimeOutput"
    if tool_loop:
        name, args = "read_file", {"file_path": "/skills/not-present/SKILL.md"}
    if invalid:
        args = {"candidates": "invalid"}
    return httpx.Response(200, request=request, json={
        "id": "synthetic-smoke", "object": "chat.completion", "created": 1, "model": model,
        "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": "",
                     "tool_calls": [{"id": "synthetic-call", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    })


def offline_runtime_reply(bundle):
    from notalone.reply.context import ContextEvidence, ReplyContext
    from notalone.reply.interface import GenerateReply, RewriteDraft
    from notalone.scopes import ContactScope
    from notalone.skills import SkillCatalog

    class EmptySkills:
        def catalog(self, scope):
            return SkillCatalog(scope=scope, revision=0, entries=())

    scope = ContactScope(uuid4(), uuid4())
    command = GenerateReply(idempotency_key=uuid4(), scope=scope, conversation_binding_id=uuid4(),
                            content=RewriteDraft(DRAFT, user_instruction=INSTRUCTION))
    prepared = ReplyContext(reply_request_id=uuid4(), command=command, scope=scope, current_text=DRAFT,
                            direction=None, evidence=(ContextEvidence(uuid4(), "user_draft", DRAFT, scope),), skill_library_revision=0)
    return LangChainReplyRuntime(model=bundle.model, skill_port=EmptySkills(),
                                 input_budget_profile=input_profile(), input_token_counter=bundle.counter).generate(prepared)


class SmokeBackend:
    """真实生产HTTP与PG；只建一个空合成联系人，不装配Worker或同步。"""

    def __init__(self, bundle, directory):
        import unittest
        import psycopg
        from notalone.application.memory_service import MemoryService
        from notalone.application.model_priority import ModelPriorityControl
        from notalone.application.setup_service import SetupService
        from notalone.application.skill_service import LedgerService, SkillService
        from notalone.application.task_service import TaskService
        from notalone.persistence.background_tasks import PostgresBackgroundTaskRepository
        from notalone.persistence.conversation_repository import PostgresConversationBindingRepository
        from notalone.persistence.memory_store import PostgresMemoryStore
        from notalone.persistence.setup_owner_directory import PostgresOwnerDirectory
        from notalone.persistence.owner_memory_store import PostgresOwnerMemoryStore
        from notalone.persistence.outbound_ledger import PostgresOutboundLedger
        from notalone.persistence.skill_library import PostgresSkillLibrary
        from notalone.server.app import create_app
        from notalone.server.reply_wiring import build_reply_service
        from tests.integration.server.core_business_flow_support import CoreBusinessFlowFixture, HttpBackend

        class Database(CoreBusinessFlowFixture, unittest.TestCase):
            _database_ownership_path = directory / "database-owned.json"

        self.database = Database
        self.backend = None
        self.priority = ModelPriorityControl()
        self.bundle = bundle
        try:
            Database.setUpClass()
            self.owner_id, self.contact_id = uuid4(), uuid4()
            self.database_url = Database.database_url
            self.database_name = Database.database_name
            with psycopg.connect(self.database_url) as connection:
                connection.execute("INSERT INTO public.owner (id, display_name) VALUES (%s, '合成模型冒烟用户')", (self.owner_id,))
                connection.execute("INSERT INTO public.contact (id,owner_id,display_name) VALUES (%s,%s,'合成模型冒烟联系人')", (self.contact_id, self.owner_id))
                connection.execute("INSERT INTO public.skill_library (owner_id,revision) VALUES (%s,0)", (self.owner_id,))
            PostgresConversationBindingRepository(self.database_url).create_binding(
                owner_id=self.owner_id, contact_id=self.contact_id, channel="wechat",
                account_scope=f"synthetic-smoke-{self.owner_id}", conversation_locator=f"synthetic-smoke-{self.contact_id}",
            )
            def single_call_runtime(**options):
                # 本场仅验证冻结的一次生成；候选复核由独立SDK/HTTP回归覆盖。
                # 保留实际运行时、完整输入计量与逐次台账，不扩大已领取调用预算。
                return LangChainReplyRuntime(**{**options, "constraint_review": None})

            with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=bundle.model), \
                    patch("notalone.server.reply_wiring.LangChainReplyRuntime", side_effect=single_call_runtime):
                reply = build_reply_service(database_url=self.database_url, owner_id=self.owner_id,
                                            model_priority=self.priority, input_budget_profile=input_profile(), input_token_counter=bundle.counter)

            def shutdown():
                self.priority.stop()
                bundle.budget.close()

            self.backend = HttpBackend(create_app(
                database_url=self.database_url, owner_id=self.owner_id, reply_service=reply,
                runtime_shutdown=shutdown,
                ledger_service=LedgerService(ledger=PostgresOutboundLedger(self.database_url)),
                memory_service=MemoryService(contact_memory=PostgresMemoryStore(self.database_url), owner_memory=PostgresOwnerMemoryStore(self.database_url)),
                skill_service=SkillService(management=PostgresSkillLibrary(self.database_url)),
                task_service=TaskService(repository=PostgresBackgroundTaskRepository(self.database_url)),
                setup_service=SetupService(owner_directory=PostgresOwnerDirectory(self.database_url), env_path=directory / "synthetic.env"),
            ), self.owner_id)
        except BaseException as error:
            try:
                self.close()
            except BaseException:
                error.add_note("smoke_constructor_cleanup_unconfirmed")
            raise

    def metadata(self):
        return {"owner_id": str(self.owner_id), "contact_id": str(self.contact_id),
                "database_name": self.database_name, "database_url": self.database_url}

    def inspect(self):
        import psycopg
        with psycopg.connect(self.database_url) as connection:
            counts = {table: connection.execute(f"SELECT count(*) FROM public.{table}").fetchone()[0]
                      for table in ("message", "confirmed_memory", "memory_candidate", "source_document", "background_task", "reply_request")}
            turns = connection.execute("SELECT state FROM public.reply_request ORDER BY created_at").fetchall()
        try:
            budget = self.bundle.budget.snapshot()
        except EvaluationBudgetAbort:
            budget = self.bundle.budget.closed_receipt()
        return {"counts": counts, "reply_states": [row[0] for row in turns],
                "budget": budget, **self.bundle.audit.metadata()}

    def close(self):
        failed = False
        try:
            if self.backend is not None:
                self.backend.close()
                self.backend = None
        except BaseException:
            failed = True
        finally:
            self.priority.stop()
        self.database.doClassCleanups()
        if failed or self.database.tearDown_exceptions:
            raise RuntimeError("smoke_database_cleanup_unconfirmed")
        import psycopg
        with psycopg.connect("host=/tmp dbname=postgres", connect_timeout=3) as admin:
            if admin.execute("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)", (self.database.database_name,)).fetchone()[0]:
                raise RuntimeError("smoke_database_cleanup_unconfirmed")


def read_authorized_key(path):
    if path.name.startswith(".env") and path != PROJECT_ENV:
        raise ValueError("smoke_key_file_invalid")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        identity = os.fstat(descriptor)
        if not stat.S_ISREG(identity.st_mode) or identity.st_uid != os.getuid() or identity.st_mode & 0o077:
            raise ValueError("smoke_key_file_invalid")
        project_env = path == PROJECT_ENV
        limit = 16384 if project_env else 1024
        raw = os.read(descriptor, limit + 1)
        if len(raw) > limit:
            raise ValueError("smoke_key_file_invalid")
        if project_env:
            # 只取显式项目文件的三项；不加载进环境，不插值，不读取其他凭据来源。
            wanted = {"NOTALONE_DEEPSEEK_API_KEY", "NOTALONE_DEEPSEEK_BASE_URL", "NOTALONE_DEEPSEEK_MODEL"}
            values = {}
            for line in raw.decode("utf-8").splitlines():
                name, separator, value = line.strip().removeprefix("export ").partition("=")
                name = name.strip()
                if name not in wanted:
                    continue
                parsed = shlex.split(value, comments=True, posix=True)
                if not separator or name in values or len(parsed) != 1:
                    raise ValueError("smoke_provider_source_invalid")
                values[name] = parsed[0]
            if (set(values) != wanted or values["NOTALONE_DEEPSEEK_BASE_URL"] not in {BASE_URL, BASE_URL + "/"}
                    or values["NOTALONE_DEEPSEEK_MODEL"] != MODEL):
                raise ValueError("smoke_provider_source_invalid")
            key = values["NOTALONE_DEEPSEEK_API_KEY"]
        else:
            key = raw.decode("utf-8").strip()
        if not 10 <= len(key) <= 512 or "$" in key or any(ord(c) < 33 or ord(c) > 126 for c in key):
            raise ValueError("smoke_key_file_invalid")
        return key
    finally:
        os.close(descriptor)


def finalize_resources(budget, backend, bundle, remove_info, output, original=None):
    """预算磁盘故障不阻断独立资源收尾；未知关闭不能写成成功。"""
    failures = []
    receipt = None
    backend_closed = bundle_closed = info_removed = False
    try:
        budget.close()
    except BaseException:
        failures.append("budget_close")
    try:
        receipt = budget.closed_receipt()
    except BaseException:
        failures.append("budget_receipt")
    try:
        if backend is not None:
            backend.close()
            backend_closed = True
    except BaseException:
        failures.append("backend_cleanup")
    try:
        if bundle is not None:
            bundle.close()
            bundle_closed = True
    except BaseException:
        failures.append("client_cleanup")
    # 后端关闭不明时保留握手及归属线索，不让仍存活的服务失去定位。
    if backend_closed:
        try:
            remove_info()
            info_removed = True
        except BaseException:
            failures.append("handshake_cleanup")
    result = {"budget": receipt, "budget_close_confirmed": receipt is not None,
              "cleanup_confirmed": backend_closed and bundle_closed and info_removed,
              "unconfirmed": failures}
    try:
        descriptor = os.open(output / "reply-smoke-closed.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as record:
            json.dump(result, record)
            record.flush()
            os.fsync(record.fileno())
    except BaseException:
        failures.append("closure_record")
    if failures:
        if original is not None:
            original.add_note("smoke_cleanup_unconfirmed")
        else:
            raise RuntimeError("smoke_cleanup_unconfirmed")
    return result


def main():
    from notalone.server.connection_info import remove_backend_info, write_backend_info
    run_id, key_path, digest = require_live_configuration(os.environ)
    directory = Path(os.environ["NOTALONE_REPLY_MODEL_SMOKE_FIXTURE_DIRECTORY"])
    output = Path(os.environ["NOTALONE_REPLY_MODEL_SMOKE_OUTPUT"])
    if not directory.is_absolute() or not output.is_absolute() or directory == output:
        raise ValueError("smoke_directory_invalid")
    # create不可重入；领取成功之后才读取此次明确指定的凭据来源。
    budget = EvaluationBudget.create(run_id=run_id, output_directory=output, request_limit=1,
                                     allowed_endpoints=(ENDPOINT,), config_sha256=digest)
    backend = bundle = None
    try:
        with budget.batch():
            bundle = SmokeModel(budget, read_authorized_key(key_path), audit_path=output / "reply-smoke-provider.json")
            backend = SmokeBackend(bundle, directory)
            write_backend_info(address=backend.backend.base_url.removeprefix("http://"), token=backend.backend.token)
            print(json.dumps({"ready": backend.metadata()}), flush=True)
            for line in sys.stdin:
                command = json.loads(line)
                if command["operation"] == "inspect":
                    result = backend.inspect()
                elif command["operation"] == "finish":
                    budget.close()
                    result = {"budget": budget.closed_receipt(), **bundle.audit.metadata()}
                elif command["operation"] == "stop":
                    print(json.dumps({"id": command["id"], "result": {}}), flush=True)
                    break
                else:
                    raise ValueError("smoke_command_invalid")
                print(json.dumps({"id": command["id"], "result": result}), flush=True)
    finally:
        finalize_resources(budget, backend, bundle, remove_backend_info, output, sys.exception())


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--configuration":
        print(json.dumps({"config_sha256": configuration_sha256(sys.argv[2]), "configuration": configuration(sys.argv[2])}))
    elif len(sys.argv) == 1:
        try:
            main()
        except BaseException:
            # 不将SDK原异常、请求正文或凭据串写到子进程输出。
            print(json.dumps({"failed": True, "reason": "smoke_failed_or_cleanup_unconfirmed"}), flush=True)
            sys.exit(1)
    else:
        raise SystemExit("smoke_arguments_invalid")

"""评测专用的双组物理调用捕获；不接入生产回复或发送能力。"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import stat
from time import monotonic
from uuid import uuid4

import httpx

from notalone.memory.organization_quality import content_digest
from notalone.memory_extraction.evaluation_http_budget import (
    EvaluationAsyncTransport, EvaluationBudget, EvaluationBudgetAbort, EvaluationTransport,
)


DEFAULT_ENDPOINTS = (
    "https://api.deepseek.com/chat/completions",
    "https://api.deepseek.com/v1/chat/completions",
    "https://api.deepseek.com/beta/chat/completions",
)


class _ScopedTransport(httpx.BaseTransport):
    def __init__(self, capture, delegate):
        self.capture, self.delegate = capture, delegate

    def handle_request(self, request):
        self.capture.check_attempt()
        return self.delegate.handle_request(request)

    def close(self):
        self.delegate.close()


class _ScopedAsyncTransport(httpx.AsyncBaseTransport):
    def __init__(self, capture, delegate):
        self.capture, self.delegate = capture, delegate

    async def handle_async_request(self, request):
        self.capture.check_attempt()
        return await self.delegate.handle_async_request(request)

    async def aclose(self):
        await self.delegate.aclose()


class ReplyComparisonCapture:
    """两种 SDK 路径共享一个持久预算、批次、序列和私有证据包。"""

    def __init__(self, output_directory: Path, manifest: dict, *,
                 synthetic_transport: httpx.MockTransport | None = None,
                 allowed_endpoints: tuple[str, ...] = DEFAULT_ENDPOINTS):
        request_limit = manifest.get("request_limit")
        if (manifest.get("data_kind") != "synthetic" or type(request_limit) is not int
                or not 1 <= request_limit <= 48
                or manifest.get("per_arm_limit") != 6
                or not isinstance(manifest.get("cases"), list)
                or not 1 <= len(manifest["cases"]) <= 4):
            raise ValueError("回复比较只允许至多四例合成输入、1至48次总调用和每组6次调用。")
        output = Path(output_directory)
        output.mkdir(mode=0o700, parents=True, exist_ok=True)
        identity = output.lstat()
        if (not stat.S_ISDIR(identity.st_mode) or identity.st_uid != os.getuid()
                or stat.S_IMODE(identity.st_mode) != 0o700):
            raise ValueError("证据目录须为当前用户的0700真实目录。")
        self.path = output / "bundle.json"
        try:
            descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(descriptor)
        except FileExistsError:
            raise ValueError("证据包已存在，禁止覆盖或续跑。") from None
        self.manifest = deepcopy(manifest)
        self.bundle = {
            "schema_version": "reply-comparison-v1", "run_id": str(uuid4()),
            "manifest": self.manifest, "manifest_sha256": content_digest(manifest),
            "arms": [{"case_id": case["case_id"], "arm": arm, "status": "not_run",
                      "input_sha256": case["input_sha256"], "request_id": None,
                      "elapsed_ms": None, "output": None, "evidence": {
                          "first_model_request": None, "input_budget": None, "l1_budget": None}, "error": None}
                     for case in manifest["cases"] for arm in ("baseline", "layered")],
            "calls": [], "budget_receipt": None, "reviews": [],
        }
        from uuid import UUID
        self.budget = EvaluationBudget.create(
            run_id=UUID(self.bundle["run_id"]), output_directory=output,
            request_limit=request_limit, allowed_endpoints=allowed_endpoints,
            config_sha256=self.bundle["manifest_sha256"],
        )
        self._active = None
        self._started = {}
        self._closed = False
        self.http_client = httpx.Client(trust_env=False, follow_redirects=False,
            transport=_ScopedTransport(self, EvaluationTransport(self.budget, records=self,
                synthetic_transport=synthetic_transport)))
        self.http_async_client = httpx.AsyncClient(trust_env=False, follow_redirects=False,
            transport=_ScopedAsyncTransport(self, EvaluationAsyncTransport(self.budget, records=self,
                synthetic_transport=synthetic_transport)))
        self.flush()

    def belongs_to(self, budget: EvaluationBudget) -> bool:
        return budget is self.budget

    def check_attempt(self) -> None:
        if self._active is None or self._closed:
            raise EvaluationBudgetAbort("reply_comparison_arm_not_active")
        count = sum(call["case_id"] == self._active["case_id"]
                    and call["arm"] == self._active["arm"] for call in self.bundle["calls"])
        if count >= self.manifest["per_arm_limit"]:
            raise EvaluationBudgetAbort("reply_comparison_per_arm_limit_exhausted")

    def capture_request(self, sequence: int, request: httpx.Request) -> None:
        self.check_attempt()
        try:
            payload = json.loads(request.content)
        except (ValueError, UnicodeDecodeError):
            raise EvaluationBudgetAbort("reply_comparison_request_not_json") from None
        call = {"sequence": sequence, "case_id": self._active["case_id"],
                "arm": self._active["arm"], "request_route": str(request.url),
                "request": payload, "response": None, "outcome": "unknown", "elapsed_ms": None}
        self.bundle["calls"].append(call)
        self._started[sequence] = monotonic()
        if self._active["evidence"]["first_model_request"] is None:
            self._active["evidence"]["first_model_request"] = deepcopy(payload)
        self.flush()

    def _call(self, sequence: int) -> dict:
        return next(call for call in self.bundle["calls"] if call["sequence"] == sequence)

    def capture_response(self, sequence: int, response: httpx.Response) -> None:
        call = self._call(sequence)
        try:
            call["response"] = response.json()
        except (ValueError, UnicodeDecodeError):
            call["response"] = None
        call["outcome"] = "succeeded" if 200 <= response.status_code < 300 else "failed"
        call["http_status"] = response.status_code
        call["elapsed_ms"] = round((monotonic() - self._started[sequence]) * 1000)
        self.flush()

    def capture_failure(self, sequence: int, reason: str) -> None:
        call = self._call(sequence)
        call["outcome"] = "unknown" if reason == "unknown_transport_error" else "failed"
        call["error"] = reason
        call["elapsed_ms"] = round((monotonic() - self._started[sequence]) * 1000)
        self.flush()

    def input_budget(self, decision) -> None:
        if self._active is None:
            raise EvaluationBudgetAbort("reply_comparison_budget_without_arm")
        payload = decision.to_payload() if hasattr(decision, "to_payload") else decision
        self._active["evidence"].setdefault("input_budgets", []).append(deepcopy(payload))
        if self._active["evidence"]["input_budget"] is None:
            self._active["evidence"]["input_budget"] = deepcopy(payload)
        self.flush()

    def http_step(self, *, method: str, path: str, status: int, response: object, request: object = None) -> None:
        """只保存本次公开接口回执；失败时也能回看已完成的准备。"""
        if self._active is None:
            raise EvaluationBudgetAbort("reply_comparison_http_without_arm")
        self._active["evidence"].setdefault("http_steps", []).append({
            "method": method, "path": path, "status": status, "request": deepcopy(request),
            "response": deepcopy(response)})
        self.flush()

    @contextmanager
    def arm(self, case_id: str, arm: str):
        row = next(item for item in self.bundle["arms"] if item["case_id"] == case_id and item["arm"] == arm)
        if self._active is not None or row["status"] != "not_run":
            raise EvaluationBudgetAbort("reply_comparison_arm_replay_forbidden")
        self._active = row
        started = monotonic()
        try:
            yield row
        finally:
            row["elapsed_ms"] = round((monotonic() - started) * 1000)
            self._active = None
            self.flush()

    def flush(self) -> None:
        temporary = self.path.with_name(f".bundle-{uuid4()}.json")
        descriptor = None
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                descriptor = None
                json.dump(self.bundle, stream, ensure_ascii=False, indent=2, allow_nan=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except Exception:
            if descriptor is not None:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise EvaluationBudgetAbort("reply_comparison_capture_write_failed") from None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self.budget.close()
            self.bundle["budget_receipt"] = self.budget.closed_receipt()
        finally:
            self.http_client.close()
            asyncio.run(self.http_async_client.aclose())
            self.flush()

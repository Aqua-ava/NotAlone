"""每后端实例的有界准备等待；不保存输入正文或承担生成执行。"""

from collections.abc import Callable
from contextvars import copy_context
from dataclasses import dataclass
import hashlib
import json
import threading
import time
from typing import Any
from uuid import UUID, uuid4

from notalone.application.assistant_preparation_control import (
    AssistantPreparationControl, AssistantPreparationStopped, assistant_preparation_control,
)

PREPARATION_BUDGET_SECONDS = 120.0
PREPARATION_MAX_RUNNING = 4
PREPARATION_MAX_TASKS = 64
PREPARATION_RETENTION_SECONDS = 300.0


def preparation_route(path: str) -> tuple[str, UUID | None] | None:
    parts = path.strip("/").split("/")
    if (len(parts) not in (7, 9) or parts[:2] != ["api", "contacts"]
            or parts[3] != "assistant-sessions" or parts[5] not in ("replies", "replace", "retry-interrupted")
            or parts[6] != "prepare"):
        return None
    try:
        parts[2], parts[4] = str(UUID(parts[2])), str(UUID(parts[4]))
        if len(parts) == 9:
            if parts[7] != "status":
                return None
            return "/" + "/".join(parts[:7]), UUID(parts[8])
    except ValueError:
        return None
    return "/" + "/".join(parts), None


@dataclass(slots=True, repr=False)
class _PreparationJob:
    identifier: UUID
    scope: tuple[UUID, str, UUID | None]
    request_key: UUID
    fingerprint: bytes
    control: AssistantPreparationControl
    result: tuple[int, dict[str, Any]] | None = None
    finished_at: float | None = None


class AssistantPreparationJobs:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[UUID, _PreparationJob] = {}
        self._stopped = False

    def _clean(self) -> None:
        now = time.monotonic()
        for identifier, job in tuple(self._jobs.items()):
            if job.finished_at is not None and now - job.finished_at >= PREPARATION_RETENTION_SECONDS:
                del self._jobs[identifier]

    @staticmethod
    def _pending(job: _PreparationJob) -> tuple[int, dict[str, Any]]:
        return 202, {"preparation_id": str(job.identifier), "state": "preparing"}

    def start(self, *, owner_id: UUID, path: str, manual_id: UUID | None,
              request_key: UUID, payload: Any,
              run: Callable[[], tuple[int, dict[str, Any]]]) -> tuple[int, dict[str, Any]]:
        fingerprint = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                                separators=(",", ":"), default=str).encode()).digest()
        scope = owner_id, path, manual_id
        with self._lock:
            self._clean()
            if self._stopped:
                return 503, {"error": "runtime_stopping"}
            for job in self._jobs.values():
                if job.scope == scope and job.request_key == request_key and job.result is None:
                    if job.fingerprint != fingerprint:
                        return 409, {"error": "assistant_session_input_conflict"}
                    return self._pending(job)
            running = sum(job.result is None for job in self._jobs.values())
            if running >= PREPARATION_MAX_RUNNING:
                return 503, {"error": "assistant_preparation_busy"}
            if len(self._jobs) >= PREPARATION_MAX_TASKS:
                completed = [job for job in self._jobs.values() if job.finished_at is not None]
                if not completed:
                    return 503, {"error": "assistant_preparation_busy"}
                oldest = min(completed, key=lambda item: item.finished_at)
                del self._jobs[oldest.identifier]
            job = _PreparationJob(uuid4(), scope, request_key, fingerprint,
                                  AssistantPreparationControl(time.monotonic() + PREPARATION_BUDGET_SECONDS))
            self._jobs[job.identifier] = job
            context = copy_context()
            thread = threading.Thread(target=lambda: context.run(self._run, job, run),
                                      name="notalone-assistant-preparation", daemon=True)
            thread.start()
            return self._pending(job)

    def _run(self, job: _PreparationJob, run: Callable[[], tuple[int, dict[str, Any]]]) -> None:
        token = assistant_preparation_control.set(job.control)
        try:
            job.control.check()
            result = run()
            job.control.check()
        except AssistantPreparationStopped as error:
            if error.reason == "deadline":
                result = 504, {"error": "assistant_preparation_timeout"}
            elif error.reason == "runtime_stopping":
                result = 503, {"error": "runtime_stopping"}
            else:
                result = 409, {"error": "assistant_preparation_cancelled"}
        except Exception:
            result = 500, {"error": "internal_error"}
        finally:
            assistant_preparation_control.reset(token)
        # 仅具名 prepare 的无正文回执和安全错误进入短期缓存。
        allowed = {"session_id", "turn_id", "request_key", "input_version_id", "state",
                   "error", "reason", "no_generation", "input_budget", "message"}
        result = result[0], {key: value for key, value in result[1].items() if key in allowed}
        with self._lock:
            job.result, job.finished_at = result, time.monotonic()

    def status(self, *, owner_id: UUID, path: str, manual_id: UUID | None,
               identifier: UUID, cancel: bool = False) -> tuple[int, dict[str, Any]]:
        with self._lock:
            self._clean()
            job = self._jobs.get(identifier)
            if job is None or job.scope != (owner_id, path, manual_id):
                return 404, {"error": "not_found"}
            if cancel and job.result is None:
                job.control.cancel()
                return self._pending(job)
            return job.result if job.result is not None else self._pending(job)

    def stop(self) -> None:
        with self._lock:
            self._stopped = True
            for job in self._jobs.values():
                if job.result is None:
                    job.control.cancel("runtime_stopping")

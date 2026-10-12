"""离线准备的评测专用 HTTP 硬门；生产路径没有引用或默认预算。"""

from __future__ import annotations

import fcntl
import json
import os
import re
import sqlite3
import stat
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Iterator
from uuid import UUID

import httpx

if TYPE_CHECKING:
    from .evaluation_provider_contract import ECNUEvaluationContract
    from .evaluation_records import EvaluationRecordStore


class EvaluationBudgetAbort(BaseException):
    """必须由评测最外层关闭批次；越过 SDK 的 Exception 自动重试。"""


def _private_path(path: Path, *, directory: bool) -> os.stat_result:
    value = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        not kind(value.st_mode)
        or value.st_uid != os.getuid()
        or stat.S_IMODE(value.st_mode) != (0o700 if directory else 0o600)
        or (not directory and value.st_nlink != 1)
    ):
        raise EvaluationBudgetAbort("unsafe_budget_path")
    return value


def _endpoint(value: str | httpx.URL) -> str:
    url = httpx.URL(value)
    if (
        url.scheme != "https"
        or not url.host
        or url.userinfo
        or url.query
        or url.fragment
    ):
        raise EvaluationBudgetAbort("invalid_endpoint")
    return str(url)


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class EvaluationBudget:
    """固定用户级 run 注册；首次领取后只准原句柄使用，不恢复批次。"""

    def __init__(self, path: Path, manifest: dict):
        self._path = path
        self._manifest = manifest
        identity = _private_path(path / "budget.sqlite3", directory=False)
        self._identity = (identity.st_dev, identity.st_ino)
        self._gate = threading.Lock()
        self._blocked = False
        self._claim_identity: tuple[int, int] | None = None

    @classmethod
    def create(
        cls,
        *,
        run_id: UUID,
        output_directory: Path,
        request_limit: int,
        allowed_endpoints: tuple[str, ...],
        config_sha256: str,
    ) -> EvaluationBudget:
        """同一 run 只准 create 一次；不创建或读取输出正文。"""
        try:
            if (
                not isinstance(run_id, UUID)
                or type(request_limit) is not int
                or request_limit < 1
                or not re.fullmatch(r"[0-9a-f]{64}", config_sha256)
                or not allowed_endpoints
            ):
                raise EvaluationBudgetAbort("invalid_frozen_budget")
            output = output_directory.resolve(strict=True)
            output_identity = _private_path(output, directory=True)
            endpoints = sorted(set(_endpoint(value) for value in allowed_endpoints))
            root = Path.home() / ".notalone-memory-evaluations"
            root.mkdir(mode=0o700, exist_ok=True)
            _private_path(root, directory=True)
            path = root / str(run_id)
            path.mkdir(mode=0o700)
            _sync_directory(root)
            for filename in ("budget.sqlite3", "in-flight.lock"):
                descriptor = os.open(
                    path / filename,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                    0o600,
                )
                os.close(descriptor)
            manifest = {
                "run_id": str(run_id),
                "output_directory": str(output),
                "output_identity": [output_identity.st_dev, output_identity.st_ino],
                "request_limit": request_limit,
                "allowed_endpoints": endpoints,
                "config_sha256": config_sha256,
            }
            budget = cls(path, manifest)
            with budget._connection() as database:
                database.execute(
                    "CREATE TABLE state "
                    "(manifest TEXT NOT NULL, closed INTEGER NOT NULL)"
                )
                database.execute(
                    "CREATE TABLE requests "
                    "(sequence INTEGER PRIMARY KEY, endpoint TEXT NOT NULL)"
                )
                database.execute(
                    "INSERT INTO state VALUES (?, 0)",
                    (json.dumps(manifest, sort_keys=True),),
                )
            _sync_directory(path)
            return budget
        except EvaluationBudgetAbort:
            raise
        except Exception:
            raise EvaluationBudgetAbort("budget_create_failed") from None

    @classmethod
    def open(cls, *, run_id: UUID) -> EvaluationBudget:
        """仅承接尚未领取、零预约的准备运行；未知运行不恢复。"""
        try:
            if not isinstance(run_id, UUID):
                raise EvaluationBudgetAbort("invalid_run_id")
            root = Path.home() / ".notalone-memory-evaluations"
            _private_path(root, directory=True)
            path = root / str(run_id)
            _private_path(path, directory=True)
            if os.path.lexists(path / "closed"):
                raise EvaluationBudgetAbort("budget_closed")
            if os.path.lexists(path / "claimed"):
                raise EvaluationBudgetAbort("batch_already_claimed")
            _private_path(path / "budget.sqlite3", directory=False)
            database = sqlite3.connect(
                f"file:{path / 'budget.sqlite3'}?mode=rw", uri=True
            )
            try:
                rows = database.execute("SELECT manifest, closed FROM state").fetchall()
                count = database.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
            finally:
                database.close()
            if len(rows) != 1 or rows[0][1] != 0:
                raise EvaluationBudgetAbort("budget_closed_or_invalid")
            if count != 0:
                raise EvaluationBudgetAbort("unknown_batch_cannot_resume")
            manifest = json.loads(rows[0][0])
            if manifest["run_id"] != str(run_id):
                raise EvaluationBudgetAbort("budget_identity_changed")
            budget = cls(path, manifest)
            budget.snapshot()
            return budget
        except EvaluationBudgetAbort:
            raise
        except Exception:
            raise EvaluationBudgetAbort("budget_open_failed") from None

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        _private_path(self._path.parent, directory=True)
        _private_path(self._path, directory=True)
        identity = _private_path(self._path / "budget.sqlite3", directory=False)
        if (identity.st_dev, identity.st_ino) != self._identity:
            raise EvaluationBudgetAbort("budget_identity_changed")
        database = sqlite3.connect(
            f"file:{self._path / 'budget.sqlite3'}?mode=rw", uri=True, timeout=0
        )
        try:
            database.execute("PRAGMA synchronous=FULL")
            database.execute("BEGIN IMMEDIATE")
            yield database
            database.commit()
            _sync_directory(self._path)
        finally:
            database.close()

    def _validate(self, database: sqlite3.Connection) -> int:
        rows = database.execute("SELECT manifest, closed FROM state").fetchall()
        if (
            self._blocked
            or os.path.lexists(self._path / "closed")
            or len(rows) != 1
            or rows[0] != (json.dumps(self._manifest, sort_keys=True), 0)
        ):
            raise EvaluationBudgetAbort("budget_closed_or_changed")
        claimed = self._path / "claimed"
        if os.path.lexists(claimed):
            identity = _private_path(claimed, directory=False)
            if (identity.st_dev, identity.st_ino) != self._claim_identity:
                raise EvaluationBudgetAbort("batch_claim_not_owned")
        elif self._claim_identity is not None:
            raise EvaluationBudgetAbort("batch_claim_missing")
        output = Path(self._manifest["output_directory"])
        identity = _private_path(output, directory=True)
        if [identity.st_dev, identity.st_ino] != self._manifest["output_identity"]:
            raise EvaluationBudgetAbort("output_identity_changed")
        attempts = database.execute(
            "SELECT sequence, endpoint FROM requests ORDER BY sequence"
        ).fetchall()
        if (
            len(attempts) > self._manifest["request_limit"]
            or any(
                sequence != index
                or endpoint not in self._manifest["allowed_endpoints"]
                for index, (sequence, endpoint) in enumerate(attempts, 1)
            )
        ):
            raise EvaluationBudgetAbort("budget_records_invalid")
        return len(attempts)

    def _claim(self) -> None:
        with self._connection() as database:
            self._validate(database)
            if self._claim_identity is not None:
                return
            descriptor = os.open(
                self._path / "claimed",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            _sync_directory(self._path)
            identity = _private_path(self._path / "claimed", directory=False)
            self._claim_identity = (identity.st_dev, identity.st_ino)

    @contextmanager
    def batch(self) -> Iterator[None]:
        """首次发送前持久领取；正常或异常退场都关闭，保留原始异常。"""
        try:
            if self._claim_identity is not None:
                raise EvaluationBudgetAbort("batch_already_claimed")
            self._claim()
        except EvaluationBudgetAbort:
            self._stop()
            raise
        except Exception:
            self._stop()
            raise EvaluationBudgetAbort("batch_claim_failed") from None
        try:
            yield
        except BaseException as error:
            try:
                self.close()
            except EvaluationBudgetAbort as closing_error:
                error.add_note(f"evaluation_close_failed:{closing_error}")
            raise
        else:
            self.close()

    def snapshot(self) -> dict:
        """只有冻结元数据和预约次数；不包含正文、headers 或秘密。"""
        try:
            with self._connection() as database:
                count = self._validate(database)
                return {**self._manifest, "reserved_requests": count}
        except EvaluationBudgetAbort:
            self._stop()
            raise
        except Exception:
            self._stop()
            raise EvaluationBudgetAbort("budget_read_failed") from None

    def _stop(self) -> None:
        self._blocked = True
        try:
            descriptor = os.open(
                self._path / "closed",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            _sync_directory(self._path)
        except FileExistsError:
            pass
        except Exception:
            # 文件系统故障不能转成普通 Exception 被 SDK 自动重试。
            raise EvaluationBudgetAbort("budget_stop_record_failed") from None

    def close(self) -> None:
        """关闭记录持久化；不退款、不删除记录、不允许原 run 续开。"""
        self._stop()
        try:
            with self._connection() as database:
                database.execute("UPDATE state SET closed=1")
        except EvaluationBudgetAbort:
            raise
        except Exception:
            raise EvaluationBudgetAbort("budget_close_failed") from None

    def closed_receipt(self) -> dict:
        """只从原句柄核对持久关闭与计数；不恢复发送能力。"""
        try:
            _private_path(self._path / "closed", directory=False)
            with self._connection() as database:
                rows = database.execute("SELECT manifest, closed FROM state").fetchall()
                attempts = database.execute(
                    "SELECT sequence, endpoint FROM requests ORDER BY sequence"
                ).fetchall()
                if (
                    rows != [(json.dumps(self._manifest, sort_keys=True), 1)]
                    or len(attempts) > self._manifest["request_limit"]
                    or any(
                        sequence != index
                        or endpoint not in self._manifest["allowed_endpoints"]
                        for index, (sequence, endpoint) in enumerate(attempts, 1)
                    )
                ):
                    raise EvaluationBudgetAbort("budget_not_durably_closed")
                return {
                    **self._manifest, "reserved_requests": len(attempts),
                    "closed": True,
                }
        except EvaluationBudgetAbort:
            raise
        except Exception:
            raise EvaluationBudgetAbort("budget_closed_receipt_unavailable") from None

    @contextmanager
    def attempt(self, request: httpx.Request) -> Iterator[int]:
        """持久提交预约后才进入 transport；全部结果都占用一次。"""
        acquired = self._gate.acquire(blocking=False)
        descriptor = None
        try:
            if not acquired:
                raise EvaluationBudgetAbort("concurrent_attempt_forbidden")
            _private_path(self._path / "in-flight.lock", directory=False)
            descriptor = os.open(
                self._path / "in-flight.lock", os.O_RDWR | os.O_NOFOLLOW
            )
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # 兼容单 transport 调用；未来评测 runner 必须显式包住整个 batch。
            self._claim()
            endpoint = _endpoint(request.url)
            with self._connection() as database:
                count = self._validate(database)
                if (
                    request.method != "POST"
                    or endpoint not in self._manifest["allowed_endpoints"]
                ):
                    raise EvaluationBudgetAbort("endpoint_not_allowed")
                if count >= self._manifest["request_limit"]:
                    raise EvaluationBudgetAbort("request_limit_exhausted")
                database.execute(
                    "INSERT INTO requests VALUES (?, ?)", (count + 1, endpoint)
                )
        except EvaluationBudgetAbort:
            self._stop()
            raise
        except Exception:
            self._stop()
            raise EvaluationBudgetAbort("reservation_failed") from None
        else:
            yield count + 1
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if acquired:
                self._gate.release()


def _transport_failure_kind(error: httpx.TransportError) -> str:
    for kind, code in (
        (httpx.ConnectTimeout, "connect_timeout"),
        (httpx.ReadTimeout, "read_timeout"),
        (httpx.TimeoutException, "timeout"),
        (httpx.ConnectError, "connect_error"),
        (httpx.ReadError, "read_error"),
        (httpx.WriteError, "write_error"),
    ):
        if isinstance(error, kind):
            return code
    return "transport_error"


def _check_provider_request(
    budget: EvaluationBudget, contract: ECNUEvaluationContract | None,
    request: httpx.Request,
) -> None:
    if contract is not None:
        try:
            contract.check_request(request)
        except EvaluationBudgetAbort:
            try:
                budget.close()
            except EvaluationBudgetAbort:
                pass
            raise


class EvaluationTransport(httpx.BaseTransport):
    """单次网络 transport 固定 retries=0；合成测试只能注入 MockTransport。"""

    def __init__(
        self,
        budget: EvaluationBudget,
        *,
        synthetic_transport: httpx.MockTransport | None = None,
        records: EvaluationRecordStore | None = None,
        contract: ECNUEvaluationContract | None = None,
    ):
        if (
            synthetic_transport is not None
            and type(synthetic_transport) is not httpx.MockTransport
        ):
            raise EvaluationBudgetAbort("only_mock_transport_may_be_injected")
        self._budget = budget
        if records is not None and not records.belongs_to(budget):
            raise EvaluationBudgetAbort("records_bound_to_another_budget")
        self._records = records
        self._contract = contract
        self._transport = synthetic_transport or httpx.HTTPTransport(retries=0)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        _check_provider_request(self._budget, self._contract, request)
        with self._budget.attempt(request) as sequence:
            try:
                if self._records is not None:
                    self._records.capture_request(sequence, request)
                response = self._transport.handle_request(request)
                try:
                    response.read()
                    if self._records is not None:
                        self._records.capture_response(sequence, response)
                    if self._contract is not None:
                        self._contract.observe_response(response)
                    return response
                finally:
                    response.close()
            except httpx.TransportError as error:
                if self._records is not None:
                    self._records.capture_failure(
                        sequence, _transport_failure_kind(error)
                    )
                raise
            except EvaluationBudgetAbort:
                try:
                    self._budget.close()
                except EvaluationBudgetAbort:
                    pass
                raise
            except Exception:
                if self._records is not None:
                    self._records.capture_failure(sequence, "unknown_transport_error")
                self._budget.close()
                raise EvaluationBudgetAbort("transport_result_unknown") from None

    def close(self) -> None:
        self._transport.close()


class EvaluationAsyncTransport(httpx.AsyncBaseTransport):
    """与同步路径共用同一持久预算及单在途门；不建立第二份余额。"""

    def __init__(
        self,
        budget: EvaluationBudget,
        *,
        synthetic_transport: httpx.MockTransport | None = None,
        records: EvaluationRecordStore | None = None,
        contract: ECNUEvaluationContract | None = None,
    ):
        if (
            synthetic_transport is not None
            and type(synthetic_transport) is not httpx.MockTransport
        ):
            raise EvaluationBudgetAbort("only_mock_transport_may_be_injected")
        self._budget = budget
        if records is not None and not records.belongs_to(budget):
            raise EvaluationBudgetAbort("records_bound_to_another_budget")
        self._records = records
        self._contract = contract
        self._transport = synthetic_transport or httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        _check_provider_request(self._budget, self._contract, request)
        with self._budget.attempt(request) as sequence:
            try:
                if self._records is not None:
                    self._records.capture_request(sequence, request)
                response = await self._transport.handle_async_request(request)
                try:
                    await response.aread()
                    if self._records is not None:
                        self._records.capture_response(sequence, response)
                    if self._contract is not None:
                        self._contract.observe_response(response)
                    return response
                finally:
                    await response.aclose()
            except httpx.TransportError as error:
                if self._records is not None:
                    self._records.capture_failure(
                        sequence, _transport_failure_kind(error)
                    )
                raise
            except EvaluationBudgetAbort:
                try:
                    self._budget.close()
                except EvaluationBudgetAbort:
                    pass
                raise
            except Exception:
                if self._records is not None:
                    self._records.capture_failure(sequence, "unknown_transport_error")
                self._budget.close()
                raise EvaluationBudgetAbort("transport_result_unknown") from None

    async def aclose(self) -> None:
        await self._transport.aclose()

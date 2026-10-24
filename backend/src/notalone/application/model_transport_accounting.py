"""逐物理HTTP预约；作用域与原台账身份由调用入口显式提供。"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from types import MappingProxyType
from collections.abc import Mapping
from datetime import datetime
from threading import Lock
from uuid import UUID, uuid4

import httpx

from notalone.application.model_call_accounting import ModelCallAssociation
from notalone.application.model_permit_client import SharedModelPriorityControl, ModelScopeDeleted
from notalone.ledger.models import LedgerEntry
from notalone.application.model_priority import ModelWorkStopped


class PhysicalModelAccountingAbort(BaseException):
    """穿过SDK Exception重试边界；外层须恢复为不可重放的业务失败。"""


@dataclass(frozen=True)
class PhysicalModelScope:
    control: SharedModelPriorityControl
    request_id: UUID
    owner_id: UUID
    contact_id: UUID | None
    scope_kind: str
    provider: str
    model: str
    before_dispatch: object = None
    claim: Mapping[str, object] | None = field(default=None, kw_only=True)

    def __post_init__(self):
        if not isinstance(self.control, SharedModelPriorityControl):
            raise ValueError('共享许可控制器缺失')
        if not isinstance(self.request_id, UUID) or not isinstance(self.owner_id, UUID):
            raise ValueError('请求范围身份缺失')
        if (self.contact_id is None and self.scope_kind != 'owner_memory') or (self.contact_id is not None and (not isinstance(self.contact_id, UUID) or self.scope_kind != 'contact')):
            raise ValueError('请求用途与范围不符')
        if self.claim is not None:
            expected = {'task_id', 'step_id', 'step_name', 'worker_id', 'lease_generation'}
            if not isinstance(self.claim, Mapping) or set(self.claim) != expected:
                raise ValueError('任务领取凭证字段无效')
            for key in ('task_id', 'step_id', 'worker_id'):
                if not isinstance(self.claim[key], str):
                    raise ValueError('任务领取UUID无效')
                UUID(self.claim[key])
            if not isinstance(self.claim['step_name'], str) or not self.claim['step_name'] or len(self.claim['step_name']) > 128:
                raise ValueError('任务步骤无效')
            if type(self.claim['lease_generation']) is not int or self.claim['lease_generation'] < 0:
                raise ValueError('任务租约世代无效')
            object.__setattr__(self, 'claim', MappingProxyType(dict(self.claim)))
        if not self.provider.strip() or not self.model.strip():
            raise ValueError('供应商配置身份缺失')


_ACTIVE_LOCK = Lock()
_ACTIVE_PERMITS: set[str] = set()


_CURRENT: ContextVar[PhysicalModelCall | None] = ContextVar('physical_model_call', default=None)


class PhysicalModelCall:
    """一个原SDK调用的明确身份；最多一个HTTP，禁止隐藏重试与并行复用。"""
    def __init__(self, scope: PhysicalModelScope, *, call_id: UUID, called_at: datetime,
                 ledger_entry_id: UUID | None):
        if not isinstance(call_id, UUID) or called_at.tzinfo is None:
            raise ValueError('调用身份无效')
        if (scope.contact_id is None) != (ledger_entry_id is None):
            raise ValueError('本人资料不可伪造联系人台账')
        if ledger_entry_id is not None and not isinstance(ledger_entry_id, UUID):
            raise ValueError('原台账身份无效')
        self.scope, self.call_id, self.called_at = scope, call_id, called_at
        self.ledger_entry_id = ledger_entry_id
        self.association = None
        self.response_observed = False
        self.sdk_response_complete = False
        self.finished = False
        self.reserved = False
        self.dispatched = False
        self.known_rejection = False
        self._unconfirmed_terminal_record = None
        self._active_permit = None
        self._claimed = False
        self._lock = Lock()

    def reserve(self):
        with self._lock:
            if self._claimed:
                raise PhysicalModelAccountingAbort('physical_retry_forbidden')
            self._claimed = True
        try:
            identity = self.scope.control.current_call_identity
            if not identity or not identity.get('attempt_id'):
                raise ValueError('后台整轮许可缺失')
            permit = identity['permit_id']
            with _ACTIVE_LOCK:
                if permit in _ACTIVE_PERMITS:
                    raise PhysicalModelAccountingAbort('physical_permit_busy')
                _ACTIVE_PERMITS.add(permit)
                self._active_permit = permit
            self.association = ModelCallAssociation(uuid4(), UUID(permit), self.scope.request_id,
                self.scope.owner_id, self.scope.contact_id, self.scope.scope_kind, self.scope.provider,
                self.scope.model, self.called_at, self.call_id)
            self.scope.control.reserve_physical_call(self.receipt(), claim=dict(self.scope.claim) if self.scope.claim is not None else None)
            self.reserved = True
        except Exception as error:
            raise PhysicalModelAccountingAbort('physical_reservation_unconfirmed') from error
        try:
            if self.scope.before_dispatch is not None:
                self.scope.before_dispatch()
            self.scope.control.check_physical_dispatch()
        except Exception as error:
            self._record({'dispatch': 'not_sent', 'outcome': 'cancelled'})
            self.finished = True
            # SDK内部不得重试；SDK外边界按cause恢复原业务错误。
            raise PhysicalModelAccountingAbort('physical_dispatch_rejected') from error

    def release(self):
        if self._active_permit is not None:
            with _ACTIVE_LOCK:
                _ACTIVE_PERMITS.discard(self._active_permit)
            self._active_permit = None

    def receipt(self):
        if self.association is None:
            raise PhysicalModelAccountingAbort('physical_reservation_missing')
        return self.association.receipt()

    def observed(self):
        self.response_observed = True
        self._record({'dispatch': 'response_observed', 'outcome': 'pending'})

    def _record(self, fields):
        try:
            self.scope.control.record_physical_call(self.receipt() | fields | ({'ledger_entry_id': str(self.ledger_entry_id)} if self.ledger_entry_id and self.response_observed and fields.get('outcome') != 'pending' else {}))
        except ModelScopeDeleted as error:
            self.finished = True
            if _CURRENT.get() is self:
                raise PhysicalModelAccountingAbort('physical_scope_deleted') from error
            raise ModelWorkStopped('physical_scope_deleted') from error
        except Exception as error:
            if fields.get('outcome') in ('succeeded', 'failed', 'cancelled') and self._unconfirmed_terminal_record is None:
                self._unconfirmed_terminal_record = dict(fields)
            self.scope.control.mark_physical_unconfirmed(str(self.association.attempt_id))
            if _CURRENT.get() is self:
                raise PhysicalModelAccountingAbort('physical_settlement_unconfirmed') from error
            raise ModelWorkStopped('physical_settlement_unconfirmed') from error
        else:
            # 保守unknown的ACK只确认清理写入；不能代签先前丢失的结果ACK。
            if self._unconfirmed_terminal_record == fields:
                self._unconfirmed_terminal_record = None
            if self._unconfirmed_terminal_record is not None:
                self.scope.control.mark_physical_unconfirmed(str(self.association.attempt_id))

    def complete(self, entry: LedgerEntry):
        if self.association is None:
            raise PhysicalModelAccountingAbort('physical_reservation_missing')
        if (entry.entry_id, entry.owner_id, entry.contact_id, entry.provider, entry.model_name, entry.called_at) != (
            self.ledger_entry_id, self.scope.owner_id, self.scope.contact_id, self.scope.provider, self.scope.model, self.called_at):
            raise PhysicalModelAccountingAbort('physical_ledger_identity_mismatch')
        usage = None if entry.input_tokens is None or entry.output_tokens is None else {
            'input_tokens': entry.input_tokens, 'output_tokens': entry.output_tokens,
            'cache_read_tokens': None, 'cache_write_tokens': None}
        self._record({'dispatch': 'response_observed' if self.response_observed else 'authorized_unconfirmed',
            'outcome': ('succeeded' if entry.outcome.value == 'succeeded' else 'failed') if self.response_observed and (entry.outcome.value == 'succeeded' or self.known_rejection or self.sdk_response_complete) else 'unknown',
            'legacy_outcome': entry.outcome.value, 'latency_ms': entry.latency_ms, 'usage': usage})
        self.finished = True

    def confirm_complete_http_rejection(self, response: httpx.Response):
        """仅消费完整错误实体后确认HTTP拒绝；不冒充SDK已返回。"""
        if (not isinstance(response, httpx.Response) or response.status_code < 400
                or not response.is_stream_consumed):
            raise ValueError('完整HTTP拒绝证据缺失')
        try:
            response.content
        except httpx.ResponseNotRead as error:
            raise ValueError('完整HTTP拒绝实体尚未读取') from error
        self.known_rejection = True

    def complete_owner(self, *, succeeded: bool, usage: dict | None = None):
        if self.scope.scope_kind != 'owner_memory':
            raise PhysicalModelAccountingAbort('physical_owner_scope_required')
        self._record({'dispatch': 'response_observed' if self.response_observed else 'authorized_unconfirmed',
            'outcome': ('succeeded' if succeeded else 'failed') if self.response_observed and (succeeded or self.known_rejection or self.sdk_response_complete) else 'unknown', 'usage': usage})
        self.finished = True

    def unknown(self):
        if self.association is not None and (self.reserved or self.scope.control.physical_unconfirmed) and not self.finished:
            self._record({'dispatch': 'response_observed' if self.response_observed else 'authorized_unconfirmed', 'outcome': 'unknown'})


@contextmanager
def _physical_model_call(scope: PhysicalModelScope, *, call_id: UUID, called_at: datetime,
                        ledger_entry_id: UUID | None, defer_legacy: bool = False):
    if _CURRENT.get() is not None:
        raise PhysicalModelAccountingAbort('physical_call_nested')
    call = PhysicalModelCall(scope, call_id=call_id, called_at=called_at, ledger_entry_id=ledger_entry_id)
    token = _CURRENT.set(call)
    failed = False
    try:
        yield call
    except BaseException as error:
        failed = True
        response = getattr(error, 'response', None)
        call.known_rejection = isinstance(response, httpx.Response) and response.status_code >= 400 and response.is_stream_consumed
        if isinstance(error, PhysicalModelAccountingAbort) and str(error) == 'physical_dispatch_rejected' and error.__cause__ is not None:
            raise error.__cause__
        raise
    finally:
        try:
            if failed or not defer_legacy:
                call.unknown()
        finally:
            call.release()
            _CURRENT.reset(token)


@contextmanager
def physical_model_call(scope: PhysicalModelScope, *, call_id: UUID, called_at: datetime,
                        ledger_entry_id: UUID | None, defer_legacy: bool = False):
    """SDK外恢复普通业务异常，避免内部BaseException泄漏到worker。"""
    try:
        with _physical_model_call(scope, call_id=call_id, called_at=called_at,
                                  ledger_entry_id=ledger_entry_id, defer_legacy=defer_legacy) as call:
            yield call
    except PhysicalModelAccountingAbort as error:
        raise ModelWorkStopped(str(error)) from error


def current_physical_call() -> PhysicalModelCall | None:
    return _CURRENT.get()


def _require_call() -> PhysicalModelCall:
    call = current_physical_call()
    if call is None:
        raise PhysicalModelAccountingAbort('physical_scope_missing')
    return call


class AccountingTransport(httpx.BaseTransport):
    def __init__(self, inner: httpx.BaseTransport):
        self.inner = inner

    def handle_request(self, request):
        call = _require_call()
        call.reserve()
        response = None
        try:
            call.dispatched = True
            response = self.inner.handle_request(request)
            call.observed()
            return response
        except BaseException:
            if response is not None:
                response.close()
            call.unknown()
            raise

    def close(self):
        self.inner.close()


class AsyncAccountingTransport(httpx.AsyncBaseTransport):
    def __init__(self, inner: httpx.AsyncBaseTransport):
        self.inner = inner

    async def handle_async_request(self, request):
        call = _require_call()
        call.reserve()
        response = None
        try:
            call.dispatched = True
            response = await self.inner.handle_async_request(request)
            call.observed()
            return response
        except BaseException:
            if response is not None:
                await response.aclose()
            call.unknown()
            raise

    async def aclose(self):
        await self.inner.aclose()


_TASK: ContextVar[tuple | None] = ContextVar('physical_model_task', default=None)


@contextmanager
def physical_model_task(control, *, request_id: UUID, owner_id: UUID, contact_id: UUID | None,
                        scope_kind: str = 'contact', before_dispatch=None, claim: Mapping[str, object] | None = None):
    """每个worker线程显式进入；任务UUID不能从trace名称或线程最后调用推断。"""
    if not isinstance(control, SharedModelPriorityControl):
        yield
        return
    token = _TASK.set((control, request_id, owner_id, contact_id, scope_kind, before_dispatch, MappingProxyType(dict(claim)) if claim is not None else None))
    try:
        yield
    finally:
        _TASK.reset(token)


@contextmanager
def physical_trace_call(observation, model):
    """明确绑定同一CallObservation；原台账消费前保留pending而非猜测业务结论。"""
    task = _TASK.get()
    if task is None:
        yield None
        return
    control, request, owner, contact, kind, charge, claim = task
    scope = PhysicalModelScope(control, request, owner, contact, kind, 'deepseek', model.model_name, charge, claim=claim)
    if any(getattr(item, 'max_retries', None) != 0 for item in (model, model.root_client, model.root_async_client)):
        raise PhysicalModelAccountingAbort('physical_sdk_retry_forbidden')
    with physical_model_call(scope, call_id=observation.call_id, called_at=observation.called_at,
                             ledger_entry_id=uuid4() if contact is not None else None, defer_legacy=True) as call:
        observation.physical_call = call
        yield call
        # 此入口只包invoke完整结果，不包stream迭代器；头部到达或SDK抛错不构成此证据。
        call.sdk_response_complete = True

def physical_task_claim(claim) -> dict:
    """从已领取的原任务租约构造最小元数据，不接受随机新任务或客户端额度。"""
    from notalone.tasks.models import ClaimedBackgroundTaskStep
    if not isinstance(claim, ClaimedBackgroundTaskStep) or claim.lease_generation < 1:
        raise ValueError('模型调用必须绑定有效原任务租约。')
    return {'task_id': str(claim.task_id), 'step_id': str(claim.step_id),
            'step_name': claim.name.value, 'worker_id': str(claim.worker_id),
            'lease_generation': claim.lease_generation}

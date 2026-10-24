"""迁移期通过同一个 TS 仲裁器领取许可，复用旧来源 guard 与停止语义。"""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
import sys
import socket
from typing import Iterator
from threading import local
from contextvars import ContextVar
from uuid import uuid4, UUID

from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped


class ModelScopeDeleted(ModelWorkStopped):
    """宿主已确认范围删除；不是可重试的记账故障。"""


class SharedModelPriorityControl(ModelPriorityControl):
    """不存在本地限流兜底；许可连接失败即停止新的物理调用。"""

    def __init__(self, *, socket_path: str, token: str, background_limit: int = 1):
        super().__init__(background_limit=background_limit)
        if len(token.encode()) < 32:
            raise ValueError("模型许可认证配置无效。")
        self._socket_path = socket_path
        self._permit_token = token
        self._physical = local()
        self._permit_context = ContextVar("shared_model_permit", default=None)

    @property
    def current_call_identity(self) -> dict[str, str] | None:
        """供实际transport/ledger接缝关联；不代表HTTP已经发送。"""
        state = self._permit_context.get()
        value = state[0] if state is not None else None
        return dict(value) if value is not None else None

    @property
    def last_call_identity(self) -> dict[str, str] | None:
        """本线程刚结算调用的身份；调用方仍须按原call_id核对，不能跨任务复用。"""
        value = getattr(self._physical, "last", None)
        return dict(value) if value is not None else None

    def _read_state(self, connection: socket.socket, *, cancellable: bool) -> dict:
        data = bytearray()
        while b"\n" not in data:
            if cancellable:
                self.check_running()
            try:
                chunk = connection.recv(1)
            except socket.timeout:
                if not cancellable:
                    raise ModelWorkStopped("模型许可结算未确认。")
                continue
            if not chunk or len(data) >= 4096:
                raise ModelWorkStopped("模型许可连接已失效。")
            data.extend(chunk)
        message = json.loads(data)
        if not isinstance(message, dict):
            raise ModelWorkStopped("模型许可协议无效。")
        return message

    @contextmanager
    def _shared_permit(self, kind: str, *, physical: bool = False) -> Iterator[None]:
        self.check_running()
        attempt_id = str(uuid4()) if physical else None
        if physical:
            self._physical.last = None
        context_token = None
        yielded = False
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            connection.settimeout(1.0)
            connection.connect(self._socket_path)
            connection.sendall((json.dumps({
                "op": "acquire", "kind": kind, "token": self._permit_token,
                **({"attempt_id": attempt_id} if attempt_id else {}),
                "worker": {"pid": os.getpid(), "parentPid": os.getppid(),
                           "executable": sys.executable},
            }) + "\n").encode())
            connection.settimeout(0.1)
            granted = self._read_state(connection, cancellable=True)
            if granted.get("state") != "granted":
                raise ModelWorkStopped("模型许可服务已停止。")
            permit_id = str(UUID(granted.get("permit_id", "")))
            context_token = self._permit_context.set((
                {"permit_id": permit_id, **({"attempt_id": attempt_id} if attempt_id else {})}, connection, {"unconfirmed": set()}))
            try:
                self.check_running()
                yielded = True
                yield
            finally:
                # 必须由同步 SDK 调用真正退出此作用域；不得从取消线程结算。
                state = self._permit_context.get()
                if state is not None and state[2]["unconfirmed"]:
                    # 断开使服务器保留孤儿身份，不能发送假settled。
                    raise ModelWorkStopped("物理调用台账未确认，保留恢复身份。")
                connection.settimeout(1.0)
                try:
                    connection.sendall(b'{"op":"settled"}\n')
                    if self._read_state(connection, cancellable=False).get("state") != "settled":
                        raise ModelWorkStopped("模型许可结算未确认。")
                except OSError as error:
                    raise ModelWorkStopped("模型许可结算未确认。") from error
        except (OSError, ValueError) as error:
            if yielded:
                raise
            raise ModelWorkStopped("共享模型许可不可用。") from error
        finally:
            if physical and self.current_call_identity is not None:
                self._physical.last = self.current_call_identity
            if context_token is not None:
                self._permit_context.reset(context_token)
            connection.close()

    def check_physical_dispatch(self) -> None:
        """实际HTTP前复验当前停止、原task/source guard，不只检查整轮起点。"""
        self.check_running()
        self._check_background_scope()

    def reserve_physical_call(self, receipt: dict, *, claim: dict | None = None) -> None:
        """真实SDK调用前等待持久预约；取消或ACK丢失均不得继续派发。"""
        identity = self.current_call_identity
        state = self._permit_context.get()
        connection = state[1] if state is not None else None
        if not identity or not identity.get("attempt_id") or connection is None:
            raise ModelWorkStopped("物理调用尚未领取许可。")
        if receipt.get("permit_id") != identity["permit_id"]:
            raise ModelWorkStopped("模型调用身份不匹配。")
        self.check_physical_dispatch()
        try:
            connection.sendall((json.dumps({"op": "reserve", "receipt": receipt, **({"claim": claim} if claim is not None else {})}) + "\n").encode())
            connection.settimeout(10.0)
            result = self._read_state(connection, cancellable=False)
        except BaseException:
            self.mark_physical_unconfirmed(receipt["attempt_id"])
            raise
        if result.get("state") != "reserved":
            raise ModelWorkStopped("模型调用预约未确认。")

    @property
    def physical_unconfirmed(self) -> bool:
        state = self._permit_context.get()
        return state is not None and bool(state[2]["unconfirmed"])

    def mark_physical_unconfirmed(self, attempt_id: str) -> None:
        """共享可变状态跨async任务传播；仅原持有者finally处理许可。"""
        state = self._permit_context.get()
        if state is not None:
            state[2]["unconfirmed"].add(str(UUID(attempt_id)))
            # 协作停止本进程新模型工作并唤醒排队，不归还未知许可。
            self.stop()

    def confirm_physical_record(self, attempt_id: str) -> None:
        """只消除本attempt，不能清除同permit其他未确认记录。"""
        state = self._permit_context.get()
        if state is not None:
            state[2]["unconfirmed"].discard(str(UUID(attempt_id)))

    def record_physical_call(self, receipt: dict) -> None:
        """退出SDK后仍可结算原预约，不受停止新业务标志影响。"""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10.0)
            connection.connect(self._socket_path)
            connection.sendall((json.dumps({"op": "record", "token": self._permit_token,
                                            "receipt": receipt}) + "\n").encode())
            result = self._read_state(connection, cancellable=False)
            if result == {"state": "accounting_rejected", "reason": "scope_deleted"}:
                self.confirm_physical_record(receipt["attempt_id"])
                raise ModelScopeDeleted("模型调用范围已删除。")
            if result != {"state": "recorded"}:
                raise ModelWorkStopped("模型调用台账结算未确认。")
            if receipt.get("outcome") in ("unknown", "succeeded", "failed", "cancelled"):
                self.confirm_physical_record(receipt["attempt_id"])

    def unconfirmed_requests(self, owner_id: UUID, contact_id: UUID | None) -> tuple[UUID, ...]:
        """从同一受信宿主读取旧journal/当前孤儿对应请求；失败不猜测为空。"""
        if not isinstance(owner_id, UUID) or contact_id is not None and not isinstance(contact_id, UUID):
            raise ValueError('模型恢复范围身份无效')
        collected, after = [], None
        while True:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(10.0)
                connection.connect(self._socket_path)
                connection.sendall((json.dumps({'op': 'unconfirmed_requests', 'token': self._permit_token,
                    'owner_id': str(owner_id), 'contact_id': str(contact_id) if contact_id is not None else None,
                    **({'after': after} if after is not None else {})}) + '\n').encode())
                result = self._read_state(connection, cancellable=False)
            ids, cursor = result.get('request_ids'), result.get('next_cursor')
            if (result.get('state') != 'unconfirmed_requests' or not isinstance(ids, list) or len(ids)>64
                    or any(not isinstance(item, str) for item in ids) or ids != sorted(set(ids))
                    or after is not None and any(item <= after for item in ids)):
                raise ModelWorkStopped('模型恢复资格未确认')
            collected.extend(UUID(item) for item in ids)
            if cursor is None:
                return tuple(collected)
            if not ids or cursor != ids[-1]:
                raise ModelWorkStopped('模型恢复分页资格未确认')
            after = cursor

    @contextmanager
    def foreground(self) -> Iterator[None]:
        with self._shared_permit("foreground"):
            yield

    @contextmanager
    def background_call(self) -> Iterator[None]:
        with self._shared_permit("background", physical=True):
            self._check_background_scope()
            self.check_running()
            yield
            self.check_running()
            self._check_background_scope()

    def wait_for_foreground(self) -> None:
        # 在原消费返回结果的接缝重新经过同一优先队列，不持有第二套计数。
        with self._shared_permit("background"):
            self._check_background_scope()

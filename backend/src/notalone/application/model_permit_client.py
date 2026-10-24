"""迁移期通过同一个 TS 仲裁器领取许可，复用旧来源 guard 与停止语义。"""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
import sys
import socket
from typing import Iterator
from threading import local
from uuid import uuid4, UUID

from notalone.application.model_priority import ModelPriorityControl, ModelWorkStopped


class SharedModelPriorityControl(ModelPriorityControl):
    """不存在本地限流兜底；许可连接失败即停止新的物理调用。"""

    def __init__(self, *, socket_path: str, token: str, background_limit: int = 1):
        super().__init__(background_limit=background_limit)
        if len(token.encode()) < 32:
            raise ValueError("模型许可认证配置无效。")
        self._socket_path = socket_path
        self._permit_token = token
        self._physical = local()

    @property
    def current_call_identity(self) -> dict[str, str] | None:
        """供实际transport/ledger接缝关联；不代表HTTP已经发送。"""
        value = getattr(self._physical, "current", None)
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
        previous = getattr(self._physical, "current", None)
        previous_connection = getattr(self._physical, "connection", None)
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
            self._physical.current = {"permit_id": permit_id, **({"attempt_id": attempt_id} if attempt_id else {})}
            self._physical.connection = connection
            try:
                self.check_running()
                yield
            finally:
                # 必须由同步 SDK 调用真正退出此作用域；不得从取消线程结算。
                connection.settimeout(1.0)
                connection.sendall(b'{"op":"settled"}\n')
                if self._read_state(connection, cancellable=False).get("state") != "settled":
                    raise ModelWorkStopped("模型许可结算未确认。")
        except (OSError, ValueError) as error:
            raise ModelWorkStopped("共享模型许可不可用。") from error
        finally:
            if physical and getattr(self._physical, "current", None) is not None:
                self._physical.last = dict(self._physical.current)
            self._physical.current = previous
            self._physical.connection = previous_connection
            connection.close()

    def reserve_physical_call(self, receipt: dict) -> None:
        """真实SDK调用前等待持久预约；取消或ACK丢失均不得继续派发。"""
        identity = self.current_call_identity
        connection = getattr(self._physical, "connection", None)
        if not identity or not identity.get("attempt_id") or connection is None:
            raise ModelWorkStopped("物理调用尚未领取许可。")
        if receipt.get("permit_id") != identity["permit_id"]:
            raise ModelWorkStopped("模型调用身份不匹配。")
        self.check_running()
        connection.sendall((json.dumps({"op": "reserve", "receipt": receipt}) + "\n").encode())
        # 等到预约结果再检查取消，防止finally的settled与未完成预约交错。
        connection.settimeout(10.0)
        if self._read_state(connection, cancellable=False).get("state") != "reserved":
            raise ModelWorkStopped("模型调用预约未确认。")
        self.check_running()

    def record_physical_call(self, receipt: dict) -> None:
        """退出SDK后仍可结算原预约，不受停止新业务标志影响。"""
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(10.0)
            connection.connect(self._socket_path)
            connection.sendall((json.dumps({"op": "record", "token": self._permit_token,
                                            "receipt": receipt}) + "\n").encode())
            if self._read_state(connection, cancellable=False).get("state") != "recorded":
                raise ModelWorkStopped("模型调用台账结算未确认。")

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

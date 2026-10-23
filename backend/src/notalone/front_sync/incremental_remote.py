"""迁移期串行组合：交替执行 Python 历史单页与 TS 增量单页，无请求级回退。"""
from __future__ import annotations

from dataclasses import fields, replace
from datetime import datetime
import http.client
import json
import re
import socket
import threading
from time import monotonic
from urllib.parse import urlsplit
from uuid import UUID

from notalone.front_sync.cli_sync import CliBackgroundSync, CliSyncCycleResult, CliSyncPhase, CliSyncStatus
from notalone.front_sync.tail_lifecycle import FollowRuntimeStatus


class IncrementalRemoteError(RuntimeError):
    def __init__(self, code: str = 'sync_incremental_remote_unavailable') -> None:
        super().__init__(code)
        self.code = code


def incremental_transfer_enabled(environment) -> bool:
    """完整配置才开放回调端点；畸形或部分移交配置必须拒绝。"""
    url = environment.get('NOTALONE_SYNC_INCREMENTAL_URL')
    token = environment.get('NOTALONE_SYNC_INCREMENTAL_TOKEN')
    transferred = environment.get('NOTALONE_SYNC_INCREMENTAL_TRANSFERRED')
    if url is None and token is None and transferred is None:
        return False
    if transferred != '1' or not url or not token:
        raise ValueError('sync_incremental_remote_config_incomplete')
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'
                 and parsed.port is not None and 0 < parsed.port < 65536
                 and not parsed.username and not parsed.password
                 and not parsed.path and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise ValueError('sync_incremental_remote_config_invalid')
    return True


class RemoteIncrementalBackground:
    """只有现有 SyncHost 驱动 cycle；本适配器不启动线程循环或 CLI。"""

    def __init__(self, *, url: str, token: str, owner_id: UUID,
                 account_scope: str, history: CliBackgroundSync) -> None:
        try:
            parsed = urlsplit(url)
            valid = (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1'
                     and parsed.port is not None and not parsed.username and not parsed.password
                     and not parsed.path and not parsed.query and not parsed.fragment)
        except ValueError:
            valid = False
        if not valid or not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError('sync_incremental_remote_config_invalid')
        if not history._history_only:
            raise ValueError('sync_incremental_history_only_required')
        # factory 构造的新实例尚无在途；仍明确关闭旧流/队列再移交。
        # 活跃实例的移交必须先在 SyncHost 锁内取消 I/O 和排空，不能只调用此构造器。
        history.close()
        self._history = history
        self._port, self._token = parsed.port, token
        self._scope = {'owner_id': str(owner_id), 'channel': 'wechat', 'account_scope': account_scope}
        self._lock = threading.Lock()
        self._connections: set[http.client.HTTPConnection] = set()
        self._epoch = 0
        self._closed = False
        self._suspended = False
        self._last_status = CliSyncStatus(CliSyncPhase.DISABLED, False, None, None, 0)
        self._last_follow = FollowRuntimeStatus(False, False)
        self._history_turn = True
        self._history_failure = None
        self._scope_failure = None

    @staticmethod
    def _interrupt(connection: http.client.HTTPConnection) -> None:
        if connection.sock is not None:
            try:
                connection.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    def _request(self, operation: str, extra: dict | None = None, *, timeout: float = 8.0) -> dict:
        connection = http.client.HTTPConnection('127.0.0.1', self._port, timeout=timeout)
        # 只允许下方显式 connect；取消后 request/send 绝不能自行重新连接。
        connection.auto_open = 0
        expired = threading.Event()
        with self._lock:
            if self._closed:
                raise IncrementalRemoteError('runtime_stopping')
            epoch = self._epoch
            self._connections.add(connection)
        def interrupt():
            expired.set()
            self._interrupt(connection)
        deadline = threading.Timer(timeout, interrupt)
        deadline.daemon = True
        deadline.start()
        try:
            connection.connect()
            with self._lock:
                if self._closed or self._epoch != epoch or expired.is_set():
                    raise IncrementalRemoteError('runtime_stopping')
            connection.request('POST', '/api/runtime/sync-incremental/' + operation,
                               body=json.dumps({**self._scope, **(extra or {})}).encode(),
                               headers={'Authorization': 'Bearer ' + self._token,
                                        'Content-Type': 'application/json'})
            response = connection.getresponse()
            payload = response.read(262145)
            if len(payload) > 262144:
                raise IncrementalRemoteError('sync_incremental_remote_invalid_response')
            result = json.loads(payload, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(result, dict):
                raise IncrementalRemoteError('sync_incremental_remote_invalid_response')
            with self._lock:
                if self._closed or self._epoch != epoch or expired.is_set():
                    raise IncrementalRemoteError('runtime_stopping')
            if response.status != 200:
                code = result.get('error')
                raise IncrementalRemoteError(code if isinstance(code, str) and re.fullmatch(r'[a-z][a-z0-9_]{0,95}', code) else 'sync_incremental_remote_unavailable')
            return result
        except IncrementalRemoteError:
            raise
        except Exception:
            raise IncrementalRemoteError() from None
        finally:
            deadline.cancel()
            with self._lock:
                self._connections.discard(connection)
            connection.close()

    def _status(self, payload: dict) -> CliSyncStatus:
        try:
            names = {f.name for f in fields(CliSyncStatus)} - {'history_coverages'}
            values = {k: v for k, v in payload.items() if k in names}
            values['phase'] = CliSyncPhase(values['phase'])
            if not isinstance(values.get('stream_active'), bool) or not isinstance(values.get('bound_count'), int):
                raise ValueError()
            for key in ('priority_contact_id', 'backfill_contact_id'):
                if values.get(key) is not None:
                    values[key] = UUID(values[key])
            if values.get('priority_last_success_at') is not None:
                values['priority_last_success_at'] = datetime.fromisoformat(values['priority_last_success_at'].replace('Z', '+00:00'))
            return CliSyncStatus(**values)
        except (KeyError, TypeError, ValueError):
            raise IncrementalRemoteError('sync_incremental_remote_invalid_response') from None

    def cycle(self, *, enabled: bool, priority_contact_id: UUID | None = None,
              max_bindings: int | None = None, priority_requested_at: float | None = None,
              cli_deadline: float | None = None) -> CliSyncCycleResult:
        with self._lock:
            if self._closed or (enabled and self._suspended):
                raise IncrementalRemoteError('runtime_stopping')
            epoch = self._epoch
        if not enabled:
            # 正常关闭后的宿主心跳仍须可报告状态；只读本地覆盖，不恢复远端执行。
            history = self._history.cycle(enabled=False, max_bindings=1)
            status = replace(self._last_status, phase=CliSyncPhase.DISABLED,
                             stream_active=False, stream_mode=None, pending_count=0,
                             bound_count=history.status.bound_count,
                             failure_code=history.status.failure_code,
                             history_coverages=history.status.history_coverages)
            return CliSyncCycleResult(status, 0, history.cli_available, history.cli_failure_code)
        # 现有 SyncHost 的 engine_lock 持有整个片；只做一类正文单页。
        # 授权和状态检查不读 CLI，完成历史后直接移交下一次 TS 片。
        pending_history = enabled and self._history.history_only_pending()
        if pending_history and self._history_turn:
            history = self._history.cycle(enabled=True, priority_contact_id=priority_contact_id,
                                          max_bindings=1, priority_requested_at=priority_requested_at,
                                          cli_deadline=cli_deadline)
            with self._lock:
                if self._closed or self._suspended or self._epoch != epoch:
                    raise IncrementalRemoteError('runtime_stopping')
            self._history_turn = False
            self._history_failure = history.status.failure_code
            status = replace(self._last_status, history_coverages=history.status.history_coverages,
                             bound_count=history.status.bound_count,
                             failure_code=self._last_status.failure_code or self._history_failure,
                             phase=CliSyncPhase.DEGRADED if self._last_status.failure_code or self._history_failure
                             else CliSyncPhase.ACTIVE)
            return CliSyncCycleResult(status, history.batch_message_count,
                                      history.cli_available, history.cli_failure_code)
        self._history_turn = True
        if not enabled:
            self._history.cycle(enabled=False, max_bindings=1)
        coverages = self._history.current_history_coverages()
        with self._lock:
            if self._closed or self._suspended or self._epoch != epoch:
                raise IncrementalRemoteError('runtime_stopping')
        if cli_deadline is not None and cli_deadline <= monotonic():
            return CliSyncCycleResult(replace(self._last_status, history_coverages=coverages), 0)
        timeout = 3.0 if cli_deadline is None else max(0.001, min(3.0, cli_deadline-monotonic()))
        payload = self._request('cycle', {'max_bindings': 1,
            'priority_contact_id': None if priority_contact_id is None else str(priority_contact_id),
            'priority_requested_at': priority_requested_at}, timeout=timeout)
        code = payload.get('sync_scope_failure_code')
        self._scope_failure = code if code in {None, 'sync_scope_identity_conflict',
            'sync_scope_session_limit', 'sync_scope_discovery_failed'} else 'sync_scope_discovery_failed'
        status = self._status(payload)
        self._last_status = status
        # 普通周期只用本次响应投影；进程号须显式诊断取得，不推测存活。
        self._last_follow = FollowRuntimeStatus(
            self._last_follow.enabled, status.stream_active,
            process_id=None, mode=status.stream_mode, watermark=None)
        if not pending_history:
            self._history_failure = None
        failure = status.failure_code or self._history_failure
        status = replace(status, history_coverages=coverages, failure_code=failure,
                         phase=CliSyncPhase.DEGRADED if enabled and failure else status.phase)
        return CliSyncCycleResult(status, payload.get('batch_message_count', 0) if enabled else 0,
                                  payload.get('cli_available'), payload.get('cli_failure_code'))

    @property
    def scope_failure_code(self) -> str | None:
        return self._scope_failure

    def _control(self, operation: str) -> None:
        with self._lock:
            epoch = self._epoch
        self._request(operation)
        with self._lock:
            if self._closed or self._epoch != epoch:
                raise IncrementalRemoteError('runtime_stopping')
            self._suspended = False

    def enable(self) -> None:
        self._control('enable')
        self._history.request_history_start()

    def disable(self) -> None:
        self._control('disable')
        self._history.close()

    def resume(self) -> None:
        # 只供明确的恢复控制调用；cycle 不自动解除 stop。
        self._control('resume')

    def cancel_pending_io(self) -> None:
        with self._lock:
            if self._closed or self._suspended:
                return
            self._epoch += 1
            self._suspended = True
            connections = tuple(self._connections)
        for connection in connections:
            self._interrupt(connection)
        try:
            self._request('stop', timeout=2.0)
        except IncrementalRemoteError:
            # Node 可能已经关闭 API 或尚未握手；不重试、不等待重入 close。
            pass
        finally:
            self._history.close()
            self._last_follow = FollowRuntimeStatus(False, False)

    def close(self) -> None:
        """停止本轮并排空远端执行，保留 API；只有显式 enable/resume 才恢复。"""
        self.cancel_pending_io()

    def shutdown(self) -> None:
        """宿主退出的永久关闭；无论远端停止结果如何都清理本地资源。"""
        self.cancel_pending_io()
        with self._lock:
            self._closed = True
            connections = tuple(self._connections)
        for connection in connections:
            self._interrupt(connection)

    def request_safety_sweep(self) -> None:
        self._request('check')
        self._history.request_safety_sweep()

    def request_backfill_check(self) -> None:
        self.request_safety_sweep()
        self._history.request_history_start()

    def pause_backfill(self) -> None:
        self._request('pause')
        self._history.pause_backfill()

    def retry_backfill(self) -> None:
        self._request('retry')
        self._history.retry_backfill()

    def start_history_for_bindings(self, bindings):
        return self._history.start_history_for_bindings(bindings)

    def request_history_start(self) -> None:
        self._history.request_history_start()

    def _follow(self, command: str) -> FollowRuntimeStatus:
        value = self._request(command, timeout=2.0)
        if not isinstance(value.get('enabled'), bool) or not isinstance(value.get('stream_active'), bool):
            raise IncrementalRemoteError('sync_incremental_remote_invalid_response')
        self._last_follow = FollowRuntimeStatus(**{k: value[k] for k in ('enabled','stream_active','process_id','mode','watermark') if k in value})
        return self._last_follow

    def follow_runtime_status(self) -> FollowRuntimeStatus:
        if self._closed or self._suspended:
            return FollowRuntimeStatus(False, False)
        return self._last_follow

    def refresh_follow_runtime_status(self) -> FollowRuntimeStatus:
        return self._follow('follow-status')

    def enable_follow_smoke(self) -> None:
        self._follow('follow-enable')

    def disable_follow_smoke(self) -> None:
        self._follow('follow-disable')

    def interrupt_follow_stream(self) -> None:
        self._follow('follow-interrupt')


class IncrementalReadOnlyState:
    """移交后连兼容路径也只能读取旧开关；写入必须走 TS 认证端口。"""
    def __init__(self, store) -> None:
        self._store = store

    def read(self, **kwargs):
        return self._store.read(**kwargs)

    def read_bounded(self, **kwargs):
        return self._store.read_bounded(**kwargs)

    def enable(self, **kwargs):
        raise IncrementalRemoteError('sync_incremental_owned_by_typescript')

    def disable(self, **kwargs):
        raise IncrementalRemoteError('sync_incremental_owned_by_typescript')

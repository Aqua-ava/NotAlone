"""首次微信连接：固定来源探测、一次明确授权及重启恢复。"""
from collections.abc import Callable
from datetime import datetime, timezone
from secrets import compare_digest, token_urlsafe
from threading import Lock
from typing import Protocol
from uuid import UUID


class WechatSetupConflict(ValueError):
    """身份已经属于其他范围或曾撤销，不自动覆盖。"""


class WechatProbeUnavailable(RuntimeError):
    def __init__(self, code: str = 'wechat_tool_not_ready') -> None:
        self.code = code
        super().__init__('微信读取工具尚不可用。')


class WechatSetupStore(Protocol):
    def read(self, owner_id: UUID) -> str | None: ...
    def connect(self, owner_id: UUID, account_id: str, at: datetime) -> None: ...


class WechatSetupService:
    def __init__(self, *, owner_id: UUID | None, runtime_account: str | None,
                 store: WechatSetupStore, probe: Callable[[], str],
                 clock: Callable[[], datetime] | None = None,
                 confirm_probe: Callable[[str], str] | None = None) -> None:
        self._owner = owner_id
        self._runtime_account = runtime_account
        self._store = store
        self._probe = probe
        self._confirm_probe = confirm_probe
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._candidate: tuple[str, str] | None = None
        self._lock = Lock()

    @staticmethod
    def _result(state: str, account: str | None = None, token: str | None = None,
                failure: str | None = None) -> dict[str, object]:
        return dict(state=state, account_id=account, candidate_token=token, failure_code=failure)

    def _existing(self) -> dict[str, object] | None:
        if self._owner is None:
            return self._result('needs_owner')
        account = self._store.read(self._owner)
        if account is None:
            return None
        if self._runtime_account not in (None, account):
            raise WechatSetupConflict()
        return self._result('connected' if self._runtime_account == account else 'restart_required', account)

    def status(self) -> dict[str, object]:
        """启动与重连只查本机数据库，不能隐式触发微信读取权限。"""
        with self._lock:
            try:
                return self._existing() or self._result('needs_detection')
            except WechatSetupConflict:
                return self._result('conflict', failure='wechat_identity_conflict')

    def detect(self) -> dict[str, object]:
        """仅用户明确检测后调用只读渠道探测。"""
        with self._lock:
            try:
                existing = self._existing()
                if existing:
                    return existing
                account = self._probe()
                if not self._candidate or self._candidate[0] != account:
                    self._candidate = (account, token_urlsafe(32))
                return self._result('ready', account, self._candidate[1])
            except WechatSetupConflict:
                return self._result('conflict', failure='wechat_identity_conflict')
            except WechatProbeUnavailable as error:
                self._candidate = None
                return self._probe_failure(error)

    def confirm(self, *, candidate_token: str) -> dict[str, object]:
        with self._lock:
            try:
                existing = self._existing()
                if existing:
                    return existing
                if not self._candidate or not compare_digest(self._candidate[1], candidate_token):
                    return self._result('conflict', failure='wechat_candidate_expired')
                account = self._probe()
                if account != self._candidate[0]:
                    self._candidate = None
                    return self._result('conflict', failure='wechat_account_changed')
                if self._confirm_probe is not None and self._confirm_probe(account) != account:
                    self._candidate = None
                    return self._result('conflict', failure='wechat_account_changed')
                assert self._owner is not None
                self._store.connect(self._owner, account, self._clock())
                return self._result('restart_required', account)
            except WechatSetupConflict:
                return self._result('conflict', failure='wechat_identity_conflict')
            except WechatProbeUnavailable as error:
                self._candidate = None
                return self._probe_failure(error)

    def _probe_failure(self, error: WechatProbeUnavailable) -> dict[str, object]:
        # 适配层错误只输出固定码，不能把外部配置、路径或密钥回显到 UI。
        if error.code == 'wechat_account_changed':
            return self._result('conflict', failure='wechat_account_changed')
        code = error.code if error.code in ('wechat_tool_unavailable', 'wechat_tool_not_ready', 'wechat_probe_failed') else 'wechat_probe_failed'
        return self._result('tool_unavailable' if code == 'wechat_tool_unavailable' else 'tool_not_ready', failure=code)

"""Skill 普通管理／目录同步的单写者门；15审核事务不经过此门。"""

from contextlib import contextmanager
from threading import Lock, local
from typing import Callable
from uuid import UUID


class SkillManagementUnavailable(RuntimeError):
    """移交未就绪或旧管理入口已停收。"""


class SkillManagementHandoff:
    """排空旧事务后仅安装一次远端同步；远端失败不退回本地。"""

    def __init__(self):
        self._lock = Lock()
        self._local = local()
        self._accepting = True
        self._active = 0
        self._remote = None
        self._owner = None

    def _status_locked(self):
        state = 'python' if self._accepting else 'draining' if self._active else 'remote' if self._remote else 'stopped'
        return {'state': state, 'active_requests': self._active}

    def status(self):
        with self._lock:
            return self._status_locked()

    def stop(self):
        with self._lock:
            self._accepting = False
            return self._status_locked()

    def activate(self, *, owner_id: UUID, synchronize: Callable[[], int]):
        if not isinstance(owner_id, UUID) or not callable(synchronize):
            raise SkillManagementUnavailable('Skill 同步端口无效。')
        with self._lock:
            if self._accepting or self._active or self._remote is not None:
                raise SkillManagementUnavailable('Skill 管理尚未排空。')
            self._owner = owner_id
            self._remote = synchronize
            return self._status_locked()

    @contextmanager
    def local_operation(self):
        # 已获租约的同线程嵌套操作必须允许完成，外层连接退出后才释放计数。
        depth = getattr(self._local, 'depth', 0)
        if depth:
            self._local.depth = depth + 1
            try:
                yield
            finally:
                self._local.depth = depth
            return
        with self._lock:
            if not self._accepting:
                raise SkillManagementUnavailable('Skill 旧管理入口已停收。')
            self._active += 1
            self._local.depth = 1
        try:
            yield
        finally:
            self._local.depth = 0
            with self._lock:
                self._active -= 1

    def synchronize(self, owner: UUID, local_sync: Callable[[], int]) -> int:
        with self._lock:
            remote = self._remote
        if remote is not None:
            if owner != self._owner or not isinstance(owner, UUID):
                raise SkillManagementUnavailable('Skill 同步身份不匹配。')
            try:
                revision = remote()
            except Exception:
                raise SkillManagementUnavailable('Skill 目录同步暂不可用。') from None
            if type(revision) is not int or not 0 <= revision <= 2147483647:
                raise SkillManagementUnavailable('Skill 同步返回无效。')
            return revision
        # stop 与上方读取之间发生时由local_operation拒绝；绝不绕过停收。
        with self.local_operation():
            return local_sync()


skill_management_handoff = SkillManagementHandoff()

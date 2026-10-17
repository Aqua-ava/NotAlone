"""授权经验学习与待审核入口；不持有发布权限。"""

import logging
from collections.abc import Callable

from notalone.application.model_priority import ModelPriorityControl
from notalone.persistence.skill_learning import PostgresSkillLearningStore
from notalone.scopes import ContactScope
from notalone.skills.learning import SkillProposalRuntime


class PrioritySkillProposalRuntime:
    """沿既有前台优先许可，在模型前后复验原任务租约。"""

    def __init__(self, runtime: SkillProposalRuntime, control: ModelPriorityControl,
                 *, validate: Callable[[], None] = lambda: None):
        self.runtime, self.control, self.validate = runtime, control, validate

    def propose(self, *, scope, batch):
        with self.control.background_call():
            self.validate()
            result = self.runtime.propose(scope=scope, batch=batch)
        self.control.wait_for_foreground()
        self.validate()
        return result


class SkillLearningService:
    def __init__(self, store: PostgresSkillLearningStore, *, task_host=None, review=None):
        self.store, self.task_host = store, task_host
        self.review = review

    def _review_store(self):
        from notalone.persistence.skill_review import PostgresSkillReviewStore
        return PostgresSkillReviewStore(self.store.database_url)

    def skill_history(self, scope, skill_id=None):
        from notalone.persistence.skill_history import PostgresSkillHistory
        return PostgresSkillHistory(self.store.database_url).read(scope, skill_id)

    def skill_policies(self, scope):
        from notalone.persistence.skill_policies import PostgresSkillPolicies
        return PostgresSkillPolicies(self.store.database_url).read(scope)

    def change_skill_policy(self, scope, **command):
        from notalone.persistence.skill_policies import PostgresSkillPolicies
        return PostgresSkillPolicies(self.store.database_url).change(scope, **command)

    def undo_skill_policy(self, scope, **command):
        from notalone.persistence.skill_policies import PostgresSkillPolicies
        return PostgresSkillPolicies(self.store.database_url).undo(scope, **command)

    def rollback_skill(self, scope, **command):
        from notalone.persistence.skill_history import PostgresSkillHistory
        return PostgresSkillHistory(self.store.database_url).rollback(scope, **command)

    def read_draft(self, scope, draft_id):
        return self._review_store().read(scope, draft_id)

    def review_edit(self, scope, **command):
        return self._review_store().change(scope, **command)

    def review_decision(self, scope, **command):
        return self._review_store().change(scope, **command)

    def review_approve(self, scope, **command):
        return self._review_store().approve(scope, **command)

    def review_compare(self, scope, **command):
        if self.review is None:
            from notalone.skills.learning import SkillLearningUnavailable
            raise SkillLearningUnavailable()
        return self.review.compare(scope, **command)

    def list(self, scope: ContactScope) -> dict[str, object]:
        # 恢复从权威业务状态唤醒；不依靠常驻Agent或模型checkpoint。
        self.notify(scope)
        return self.store.list(scope)

    def configure(self, scope: ContactScope, **command) -> dict[str, object]:
        self.store.configure(scope, **command)
        self.notify(scope)
        return self.store.list(scope)

    def resume(self, scope: ContactScope) -> dict[str, object]:
        self.notify(scope, force_retry=True)
        return self.store.list(scope)

    def notify(self, scope: ContactScope, *, force_retry=False) -> None:
        task_id = self.store.enqueue(scope, force_retry=force_retry)
        if task_id is not None and self.task_host is not None:
            try:
                self.task_host.wake(owner_id=scope.owner_id, contact_id=scope.contact_id, task_id=task_id)
            except Exception:
                # 资料与授权已提交；暂时资源故障不改写用户决定，后续权威读取可恢复。
                logging.getLogger(__name__).warning('skill_learning_schedule_failed')


class SkillLearningTaskRunner:
    """沿原任务租约捕获有界资料，模型后仍由存储在同事务复验。"""

    def __init__(self, *, store: PostgresSkillLearningStore,
                 runtime: SkillProposalRuntime | None = None,
                 runtime_builder: Callable[[], SkillProposalRuntime] | None = None,
                 model_priority: ModelPriorityControl | None = None):
        self.store, self.runtime, self.runtime_builder = store, runtime, runtime_builder
        self.model_priority = model_priority

    def run(self, *, scope: ContactScope, claim) -> int:
        batch = self.store.capture(scope)
        if not batch.ready:
            return 0
        runtime = self.runtime or (self.runtime_builder() if self.runtime_builder else None)
        if runtime is None:
            raise RuntimeError('学习提案运行时尚未配置。')
        validate = lambda: self.store.validate(scope, claim, batch)
        if self.model_priority is not None:
            runtime = PrioritySkillProposalRuntime(runtime, self.model_priority, validate=validate)
        else:
            validate()
        proposal = runtime.propose(scope=scope, batch=batch)
        return self.store.save(scope, claim, batch, proposal)

    def verify(self, *, scope: ContactScope) -> None:
        self.store.verify(scope)

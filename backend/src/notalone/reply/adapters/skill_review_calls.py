"""审核的逐次模型调用台账；不保存callback中的正文或错误内容。"""

from datetime import datetime, timezone
from threading import Lock
import time
from uuid import uuid4

from langchain_core.callbacks import BaseCallbackHandler

from notalone.ledger.models import LedgerEntry, LedgerOutcome


class SkillReviewCallLedger(BaseCallbackHandler):
    """每轮调用前复验审核租约，结束或异常后只写一条最小回执。"""

    raise_error = True
    run_inline = True

    def __init__(self, *, scope, ledger, model_name, validate, record_call):
        self.scope, self.ledger, self.model_name = scope, ledger, model_name
        self.validate, self.record_call = validate, record_call
        self.model_guard = lambda: None
        self.pending, self.finished, self.lock = {}, set(), Lock()

    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs):
        # 此入口在预算/编码守卫之后；装配须确认不会缓存命中或先在本地限流。
        self.model_guard()
        self.validate()
        with self.lock:
            if run_id not in self.finished:
                self.pending[run_id] = (time.perf_counter(), datetime.now(timezone.utc))

    def on_llm_end(self, response, *, run_id, **kwargs):
        usage = {}
        for group in response.generations:
            for generation in group:
                metadata = getattr(generation.message, 'usage_metadata', None) or {}
                for key in ('input_tokens', 'output_tokens'):
                    value = metadata.get(key)
                    if type(value) is int and value >= 0:
                        usage[key] = usage.get(key, 0) + value
        self._finish(run_id, LedgerOutcome.SUCCEEDED, usage)

    def on_llm_error(self, error, *, run_id, **kwargs):
        self._finish(run_id, LedgerOutcome.RUN_FAILED, {})

    def _finish(self, run_id, outcome, usage):
        with self.lock:
            timing = self.pending.pop(run_id, None)
            if timing is None or run_id in self.finished:
                return
            self.finished.add(run_id)
        started, called_at = timing
        entry = self.ledger.record(LedgerEntry(entry_id=uuid4(), owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id, provider='deepseek', model_name=self.model_name,
            input_tokens=usage.get('input_tokens'), output_tokens=usage.get('output_tokens'),
            latency_ms=max(0, int((time.perf_counter()-started)*1000)), outcome=outcome, called_at=called_at))
        self.record_call(entry.entry_id)

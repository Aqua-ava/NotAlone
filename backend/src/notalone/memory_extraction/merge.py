"""合并正文重走来源核验；不以去重模型的结论替代事实依据。"""

from notalone.memory.models import AdoptionMethod
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.models import ExtractionWindow


class _ProposedMemory:
    def __init__(self, payload):
        self.payload = payload

    def extract(self, window):
        return (self.payload,)


class MemoryMergeVerifier:
    """仅使用本次已获准读取的同联系人消息，不另行跨联系人读取。"""

    def __init__(self, *, messages, verification_runtime, source_loader=None):
        self._messages = tuple(messages)
        self._source_loader = source_loader
        self._verification = verification_runtime

    def verify(self, *, scope, fact, parents, text):
        if (self._verification is None or not 1 <= len(parents) <= 8
                or not isinstance(text, str) or not 1 <= len(text.strip()) <= 4096):
            raise ValueError('合并缺少有界正文、旧版本或独立核验。')
        # 不把多个事件阶段、有效期或人工决定压成新候选的一套字段。
        if fact.event is not None or fact.conditions is not None or any(
            parent.adoption_method is not AdoptionMethod.AUTO
            or parent.valid_at != fact.valid_at or parent.invalid_at != fact.invalid_at
            or parent.event is not None or parent.conditions is not None for parent in parents
        ):
            raise ValueError('不同期限、事件或人工记忆不自动合并。')
        sources = tuple(dict.fromkeys((*fact.source_message_ids,
            *(source for parent in parents for source in parent.source_ids))))
        messages = tuple(item for item in self._messages if item.message_id in sources)
        missing = tuple(source for source in sources if source not in {item.message_id for item in messages})
        if missing and len(sources) <= 60 and self._source_loader is not None:
            messages += tuple(self._source_loader(scope, missing))
        if (not sources or len(sources) > 60
                or set(sources) != {item.message_id for item in messages}
                or sum(len(item.text) for item in messages) + len(text) > 16000):
            raise ValueError('合并原始依据缺失或超出本次有界范围。')
        # 补取的父版本通常更早；未知日期只决定稳定排列，不补造事实时间。
        messages = tuple(sorted(messages, key=lambda item: (
            item.occurred_at is None, item.occurred_at, str(item.message_id))))
        payload = {
            'text': text, 'category': fact.category.value, 'topic': fact.topic.value,
            'subject': fact.subject.value, 'source_message_ids': [str(item) for item in sources],
            'confidence': fact.confidence, 'risk_flags': list(fact.risk_flags),
            'valid_at': fact.valid_at.isoformat() if fact.valid_at else None,
            'invalid_at': fact.invalid_at.isoformat() if fact.invalid_at else None,
            'speech_act': fact.speech_act.value, 'assertion_status': fact.assertion_status.value,
            'figurative_type': fact.figurative_type.value, 'alternatives': list(fact.alternatives),
            'interpretation_reason': '对新候选与旧记忆的合并正文重新核验。', 'event': None,
            '_requires_all_sources': True,
        }
        window = ExtractionWindow(owner_id=scope.owner_id, contact_id=scope.contact_id,
            messages=messages, target_message_ids=fact.source_message_ids)
        outcome = ExtractionFlow(runtime=_ProposedMemory(payload), verification_runtime=self._verification).run(window)
        if outcome.failure_reason is not None or len(outcome.accepted) != 1:
            raise ValueError('合并正文未通过独立来源核验。')
        result = outcome.accepted[0]
        if result.text != text or set(result.source_message_ids) != set(sources):
            raise ValueError('合并核验未保持完整正文及全部来源。')
        return result

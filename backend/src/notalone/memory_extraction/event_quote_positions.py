"""将独立核验的唯一原文引句转为既有事件位置，不补字或修复错误索引。"""
EVENT_QUOTE_SCHEMA = {'type': 'object', 'additionalProperties': False,
    'properties': {'message_id': {'type': 'string', 'format': 'uuid'},
                   'quote': {'type': 'string', 'minLength': 1, 'maxLength': 8192}},
    'required': ['message_id', 'quote']}


def event_quote_positions(payloads, *, window, facts):
    messages = {str(message.message_id): message for message in window.messages}
    result = []
    for payload in payloads:
        index = payload.get('candidate_index') if isinstance(payload, dict) else None
        event = payload.get('event_verification') if isinstance(payload, dict) else None
        if type(index) is not int or not 0 <= index < len(facts) or not isinstance(event, dict):
            result.append(payload)
            continue
        sources = {str(identifier) for identifier in facts[index].source_message_ids}
        converted = dict(event)
        for slot in ('stage_evidence', 'occurrence_evidence'):
            refs = event.get(slot)
            if not isinstance(refs, list):
                continue
            located = []
            for ref in refs:
                current = ref
                if isinstance(ref, dict) and set(ref) == {'message_id', 'quote'}:
                    message = messages.get(ref['message_id']) if isinstance(ref['message_id'], str) else None
                    quote = ref['quote']
                    if (message is not None and ref['message_id'] in sources and message.text_representation == 'text'
                            and isinstance(quote, str) and 0 < len(quote) <= 8192 and quote.strip()):
                        start = message.text.find(quote)
                        if start >= 0 and message.text.find(quote, start + 1) < 0:
                            current = {'message_id': ref['message_id'], 'char_start': start, 'char_end': start+len(quote)}
                # 坏引句保留原结构，由现有逐项隔离器拒绝，不删除event或清空证据。
                located.append(current)
            converted[slot] = located
        result.append({**payload, 'event_verification': converted})
    return tuple(result)

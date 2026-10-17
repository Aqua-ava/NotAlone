"""反馈后只放行可以独立核对的新事实原文，未知自由概括不自动通过。"""


def validate_correction_proposal(work, proposal, *, profile=False):
    if not work.corrections:
        return
    memories = {(str(item.memory_id), item.revision): item for item in work.memories}
    groups = [proposal['entries']] if profile else [item['paragraphs'] for item in proposal['scenarios']]
    if not profile and any(item['title'] != '已核对的补充资料' or item['hint'] != '独立资料的原文背景。'
                           for item in proposal['scenarios']):
        raise ValueError('反馈后未能机验的标题或目录含义不得自动发布。')
    for items in groups:
        for item in items:
            references = item['references']
            key = (references[0]['memory_id'], references[0]['revision']) if len(references) == 1 else None
            memory = memories.get(key)
            if memory is None or item['text'] != memory.text:
                raise ValueError('反馈后无法机验不同含义的概括不得自动发布。')

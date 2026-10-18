"""反馈后只放行可以独立核对的新事实原文，未知自由概括不自动通过。"""


def validate_correction_proposal(work, proposal, *, profile=False, personal=False):
    if personal:
        from notalone.memory.personal_background import validate_metadata
        memories = {(str(item.memory_id), item.revision) for item in work.memories}
        groups = [proposal['entries']] if profile else [item['paragraphs'] for item in proposal['scenarios']]
        rejected = {item.get('rejected_text') for item in work.corrections if item.get('rejected_text')}
        for items in groups:
            for item in items:
                if not validate_metadata(item, profile=profile):
                    raise ValueError('个人合同不能退回无类别的旧格式。')
                refs = {(ref['memory_id'], ref['revision']) for ref in item['references']}
                if not refs or not refs <= memories or item['text'] in rejected:
                    raise ValueError('个人纠错后仅允许当前未受保护来源，不能重现已撤回正文。')
        # work.memories已在持久层排除纠错保护依据；改写含义仍须独立个人核验明确支持。
        return
    if not work.corrections:
        return
    memories = {(str(item.memory_id), item.revision): item for item in work.memories}
    groups = [proposal['entries']] if profile else [item['paragraphs'] for item in proposal['scenarios']]
    if not profile and any(item['title'] != '已核对的补充资料' or item['hint'] != '独立资料的原文背景。'
                           for item in proposal['scenarios']):
        raise ValueError('反馈后未能机验的标题或目录含义不得自动发布。')
    for items in groups:
        for item in items:
            if profile and (item['temporal_status'] != 'uncertain'
                    or item['uncertainty'] != '当前状态按原资料保留，未额外核实。'):
                raise ValueError('反馈后保守背景不得补写时间核实或新推断。')
            references = item['references']
            key = (references[0]['memory_id'], references[0]['revision']) if len(references) == 1 else None
            memory = memories.get(key)
            if memory is None or item['text'] != memory.text:
                raise ValueError('反馈后无法机验不同含义的概括不得自动发布。')

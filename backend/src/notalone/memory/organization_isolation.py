"""按主题/画像条目隔离失败；网络调用仍按整批执行。"""
from copy import deepcopy


def isolate_proposal(raw, key, validate, limit):
    """累计重验数量、引用、纠错及总预算，返回合法原文和规范化结果。"""
    if not isinstance(raw, dict) or set(raw) != {key} or not isinstance(raw[key], list):
        raise ValueError('整理输出顶层结构无效。')
    kept, rejected = [], []
    normalized = validate({key: []})
    for index, item in enumerate(raw[key]):
        if len(kept) >= limit:
            rejected.append({'index': index, 'reason': '整理输出条目数超出预算，该项未收录。'})
            continue
        try:
            candidate = validate({key: deepcopy(kept + [item])})
        except (ValueError, TypeError, KeyError) as error:
            rejected.append({'index': index, 'reason': str(error)})
            continue
        kept.append(item)
        normalized = candidate
    return {key: kept}, normalized, rejected


def select_verified(proposal, key, verdict):
    if type(verdict) is bool:
        return ({key: proposal[key] if verdict else []},
                [] if verdict else [{'index': i, 'reason': 'faithfulness_rejected'} for i in range(len(proposal[key]))])
    if not isinstance(verdict, dict) or set(verdict) != {'accepted_indices', 'rejected'}:
        raise ValueError('逐条核验返回合同无效。')
    indices, rejected = verdict['accepted_indices'], verdict['rejected']
    if (not isinstance(indices, list) or not isinstance(rejected, list)
            or any(type(i) is not int or not 0 <= i < len(proposal[key]) for i in indices)
            or len(indices) != len(set(indices))):
        raise ValueError('逐条核验索引无效。')
    return {key: [item for i, item in enumerate(proposal[key]) if i in indices]}, rejected

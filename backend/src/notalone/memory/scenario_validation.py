"""有界结构校验只证明合同合法；语义忠实度仍由独立适配器核验。"""

import re
from uuid import UUID

from notalone.memory.layered import OrganizationBudget, OrganizationInput
from notalone.memory.personal_background import FIELDS, validate_metadata


def validate_proposal(proposal: object, memories: tuple[OrganizationInput, ...],
                      budget: OrganizationBudget, *, scenarios=()) -> dict:
    if not isinstance(proposal, dict) or set(proposal) != {"scenarios"}:
        raise ValueError("主题提案结构无效。")
    previous_versions = {item["version_id"]: item for item in scenarios}
    scenarios = proposal["scenarios"]
    if not isinstance(scenarios, list) or not 0 <= len(scenarios) <= budget.max_scenarios:
        raise ValueError("主题数量越界。")
    inputs = {(str(item.memory_id), item.revision): item for item in memories}
    characters, paragraphs, topics = 0, 0, set()
    result = []
    for item in scenarios:
        if (not isinstance(item, dict) or (set(item) - {"scenario_id", "replaces"}) != {"topic_key", "title", "hint", "paragraphs"}
                or not isinstance(item["topic_key"], str)
                or re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", item["topic_key"]) is None
                or item["topic_key"] in topics):
            raise ValueError("主题身份无效。")
        topics.add(item["topic_key"])
        replaced = item.get('replaces', [])
        if (not isinstance(replaced, list) or len(replaced) != len(set(replaced))
                or any(version not in previous_versions for version in replaced)):
            raise ValueError('主题映射必须引用实际读取的同范围版本。')
        if 'scenario_id' in item and (not replaced or item['scenario_id'] not in
                {previous_versions[version]['scenario_id'] for version in replaced}):
            raise ValueError('主题身份只能继承当前明确替换的主题。')

        for name, limit in (("title", 60), ("hint", 160)):
            if (not isinstance(item[name], str) or not item[name].strip()
                    or len(item[name]) > limit or not re.search(r"[\u3400-\u9fff]", item[name])):
                raise ValueError("主题标题或目录提示无效。")
            characters += len(item[name])
        if not isinstance(item["paragraphs"], list) or not item["paragraphs"]:
            raise ValueError("主题必须包含完整段落。")
        normalized = []
        for paragraph in item["paragraphs"]:
            if (not isinstance(paragraph, dict) or set(paragraph) - (FIELDS | {"uncertainty"}) != {"text", "references"}
                    or not isinstance(paragraph["text"], str) or not paragraph["text"].strip()
                    or not isinstance(paragraph["references"], list) or not paragraph["references"]):
                raise ValueError("段落结构无效。")
            metadata = validate_metadata(paragraph)
            paragraphs += 1
            characters += len(paragraph["text"]) + sum(len(value) for value in metadata.values())
            references, seen = [], set()
            for ref in paragraph["references"]:
                if (not isinstance(ref, dict) or set(ref) != {"memory_id", "revision"}
                        or not isinstance(ref["memory_id"], str) or type(ref["revision"]) is not int):
                    raise ValueError("段落引用无效。")
                identity = (str(UUID(ref["memory_id"])), ref["revision"])
                if identity not in inputs or identity in seen:
                    raise ValueError("段落引用超出实际输入版本。")
                seen.add(identity)
                memory = inputs[identity]
                references.append({"memory_id": identity[0], "revision": identity[1],
                    "provenance_kind": memory.provenance_kind, "timing": memory.timing})
            normalized.append({"text": paragraph["text"], "references": references, **metadata})
        if any("kind" in p for p in normalized) and sum(len(p["text"]) for p in normalized) > 1500:
            raise ValueError("个人主题正文超过1500字。")
        result.append({**item, "paragraphs": normalized})
    if characters > budget.max_characters or paragraphs > budget.max_paragraphs:
        raise ValueError("主题正文预算已耗尽。")
    return {"scenarios": result}

"""长期背景的结构与直接版本引用；语义核验另由独立适配器执行。"""

from notalone.memory.scenario_validation import validate_proposal
from notalone.memory.personal_background import FIELDS, validate_metadata


def validate_profile(proposal, memories, budget):
    if not isinstance(proposal, dict) or set(proposal) != {"entries"}:
        raise ValueError("长期背景结构无效。")
    entries = proposal["entries"]
    if not isinstance(entries, list) or not 0 <= len(entries) <= budget.max_profile_entries:
        raise ValueError("长期背景条目数量越界。")
    normalized = []
    characters = 0
    for entry in entries:
        if (not isinstance(entry, dict)
                or set(entry) - FIELDS != {"text", "references", "temporal_status", "uncertainty"}
                or entry["temporal_status"] not in {"stable", "historical", "uncertain"}
                or not isinstance(entry["uncertainty"], str) or len(entry["uncertainty"]) > 240
                or entry["temporal_status"] == "uncertain" and not entry["uncertainty"].strip()):
            raise ValueError("长期背景须保留时间和不确定性。")
        metadata = validate_metadata(entry, profile=True)
        # 与主题段落使用相同的底层实际版本引用规则，不以主题文字作为证明。
        checked = validate_proposal({"scenarios": [{"topic_key": "profile", "title": "长期背景",
            "hint": "长期背景依据", "paragraphs": [{"text": entry["text"], "references": entry["references"]}]}]},
            memories, budget)["scenarios"][0]["paragraphs"][0]
        characters += len(checked["text"]) + len(entry["uncertainty"]) + len(metadata.get("basis", ""))
        normalized.append({**entry, "references": checked["references"]})
    if any("kind" in entry for entry in normalized) and sum(len(entry["text"]) for entry in normalized) > 2000:
        raise ValueError("个人画像正文超过2000字。")
    if characters > budget.max_characters:
        raise ValueError("长期背景正文预算已耗尽。")
    return {"entries": normalized}

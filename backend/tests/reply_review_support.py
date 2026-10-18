"""合成供应商的逐项复核响应；只控制流程，不推断或证明模型语义。"""

from __future__ import annotations

from typing import Any


def synthetic_review(
    payload: dict[str, Any], *, verdicts: list[str] | None = None,
    changes: list[str] | None = None, numbers: list[int] | None = None,
    requires_expansion: bool = False,
) -> dict[str, Any]:
    """保留测试的旧裁决控制，但独立构造完整供应商协议。"""
    verdicts = verdicts or ["supported"] * len(payload["candidates"])
    numbers = numbers or list(range(1, len(verdicts) + 1))
    changes = changes or ["not_applicable"] * len(verdicts)
    # 粘贴来信的当前意图来自已确认方向，不把对方来信当作用户原稿。
    source_path = ("/confirmed_direction" if payload.get("input_mode") == "reply_to_pasted_text"
                   else "/draft_text" if payload.get("draft_text") else "/user_instruction")
    source_quote = payload[source_path[1:]][:512]
    reviews = {}
    for index, (number, verdict) in enumerate(zip(numbers, verdicts)):
        checks = {name: {"reason": "合成脚本核对，仅验证流程。", "result": {"status": "supported"}}
                  for name in ("intent", "instruction", "facts", "commitments", "explanation")}
        checks["commitments"]["propositions"] = []
        if verdict == "reject":
            checks["instruction"]["result"].update(status="violation", violation={
                "category": "unmet_instruction", "candidate_path": "/text",
                "candidate_quote": payload["candidates"][index]["text"][:512],
                "source_path": source_path, "source_quote": source_quote,
            })
        elif verdict == "unknown":
            checks["instruction"]["result"]["status"] = "unknown"
        elif verdict != "supported":
            raise ValueError("合成裁决控制无效。")
        reviews[f"candidate_{index + 1}"] = {
            "candidate_number": number, "expression_change": changes[index], "checks": checks,
        }
    return {"instruction_requires_expansion": requires_expansion, "reviews": reviews}

#!/usr/bin/env python3
"""用合成中文对话验证语用解释与确定性安全闸门。

这个脚本是 prototype 的可选真实模型入口：

* 没有 NOTALONE_DEEPSEEK_API_KEY 时不会发起网络请求；
* 只发送本文件中的合成案例；
* 模型只能返回语用解释，最终动作由本文件中的纯函数决定；
* 不连接数据库，不写入 memory_candidate 或 confirmed_memory。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any


MODEL_DEFAULT = "deepseek-v4-flash"
API_KEY_ENV = "NOTALONE_DEEPSEEK_API_KEY"
MODEL_ENV = "NOTALONE_DEEPSEEK_MODEL"
BASE_URL_ENV = "NOTALONE_DEEPSEEK_BASE_URL"

ENUMS = {
    "dialogue_act": {
        "statement",
        "plan",
        "hypothetical",
        "boast",
        "quote",
        "uncertain",
        "correction",
        "evidence",
    },
    "assertion_status": {
        "asserted",
        "planned",
        "hypothetical",
        "quoted",
        "uncertain",
        "retracted",
    },
    "literalness": {"literal", "exaggerated", "ironic", "non_literal"},
    "time_status": {"past", "current", "future", "timeless"},
    "evidence_relation": {"direct", "supporting", "contradicts", "insufficient"},
}


INTERPRETATION_SCHEMA: dict[str, Any] = {
    "title": "PragmaticInterpretation",
    "description": (
        "对合成聊天窗口做语用解释。只描述说话者意图、断言状态和证据，"
        "不要输出 confirmed_memory，也不要决定最终记忆动作。"
    ),
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "proposition": {"type": "string"},
        "dialogue_act": {"type": "string", "enum": sorted(ENUMS["dialogue_act"])},
        "assertion_status": {
            "type": "string",
            "enum": sorted(ENUMS["assertion_status"]),
        },
        "literalness": {"type": "string", "enum": sorted(ENUMS["literalness"])},
        "time_status": {"type": "string", "enum": sorted(ENUMS["time_status"])},
        "alternatives": {
            "type": "array",
            "items": {"type": "string"},
        },
        "evidence_relation": {
            "type": "string",
            "enum": sorted(ENUMS["evidence_relation"]),
        },
        "source_message_ids": {
            "type": "array",
            "minItems": 1,
            "items": {"type": "string"},
        },
        "model_confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": [
        "proposition",
        "dialogue_act",
        "assertion_status",
        "literalness",
        "time_status",
        "alternatives",
        "evidence_relation",
        "source_message_ids",
        "model_confidence",
    ],
}


CASES: tuple[dict[str, Any], ...] = (
    {
        "id": "fact",
        "expected": "candidate",
        "messages": (("contact", "msg-fact-1", "我现在在上海。"),),
    },
    {
        "id": "plan",
        "expected": "plan_candidate",
        "messages": (("contact", "msg-plan-1", "我下个月准备去上海。"),),
    },
    {
        "id": "hypothetical",
        "expected": "pending",
        "messages": (("contact", "msg-hypothetical-1", "如果我有 30 万，我就加仓。"),),
    },
    {
        "id": "boast",
        "expected": "pending",
        "messages": (
            ("contact", "msg-boast-1", "明天 100w 到手，我贷款 30w 加仓。"),
            ("user", "msg-boast-2", "你又开始吹了。"),
        ),
    },
    {
        "id": "quote",
        "expected": "pending",
        "messages": (("contact", "msg-quote-1", "他说他要贷款 30 万。"),),
    },
    {
        "id": "uncertain",
        "expected": "pending",
        "messages": (("contact", "msg-uncertain-1", "我可能下个月去上海。"),),
    },
    {
        "id": "correction",
        "expected": "invalidated",
        "messages": (("contact", "msg-correction-1", "我上次说错了，没有贷款，那是吹牛。"),),
    },
    {
        "id": "evidence",
        "expected": "candidate",
        "messages": (("contact", "msg-evidence-1", "我已经提交贷款申请了。"),),
    },
)


SYSTEM_PROMPT = """你是关系聊天中的语用解释器，不是记忆采纳器。
你只分析输入的合成聊天窗口，必须使用工具返回结构化结果。
严格区分：事实陈述、未来计划、条件假设、吹牛/夸张、第三方引用、不确定表达、纠正/撤回、后续证据。
不要把字面内容直接当作现实事实；需要在 alternatives 中保留合理的其他解释。
source_message_ids 只能使用当前窗口给出的 message_id。
不要输出 memory action，不要输出 confirmed_memory；最终动作由外部确定性安全闸门决定。
"""


def _window_text(case: dict[str, Any]) -> str:
    return "\n".join(
        f"{index}. [message_id={message_id}] sender={sender}: {text}"
        for index, (sender, message_id, text) in enumerate(case["messages"], start=1)
    )


def _source_ids(case: dict[str, Any]) -> set[str]:
    return {message_id for _, message_id, _ in case["messages"]}


def validate_output(output: Any, source_ids: set[str]) -> list[str]:
    if not isinstance(output, dict):
        return ["模型工具参数不是对象"]
    errors: list[str] = []
    for field in (
        "proposition",
        "dialogue_act",
        "assertion_status",
        "literalness",
        "time_status",
        "evidence_relation",
    ):
        if not isinstance(output.get(field), str) or not output[field].strip():
            errors.append(f"{field} 缺失或不是非空字符串")
    for field, values in ENUMS.items():
        value = output.get(field)
        if isinstance(value, str) and value not in values:
            errors.append(f"{field} 不在受控枚举中")
    alternatives = output.get("alternatives")
    if not isinstance(alternatives, list) or not all(
        isinstance(item, str) for item in alternatives
    ):
        errors.append("alternatives 必须是字符串数组")
    output_source_ids = output.get("source_message_ids")
    if not isinstance(output_source_ids, list) or not output_source_ids:
        errors.append("source_message_ids 不能为空")
    elif any(item not in source_ids for item in output_source_ids):
        errors.append("source_message_ids 引用了当前窗口之外的消息")
    confidence = output.get("model_confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        errors.append("model_confidence 必须在 0 到 1 之间")
    return errors


def detect_hard_safety_cue(texts: tuple[str, ...] | list[str]) -> str | None:
    """只识别高精度降级信号；不根据关键词单独创建记忆。"""

    text = "\n".join(texts)
    if re.search(r"(?:上次|之前|刚才).{0,16}(?:说错|不对)|(?:那是|只是)吹牛|撤回", text):
        return "retraction"
    if re.search(r"如果|假如|要是", text):
        return "hypothetical"
    if re.search(r"(?:他|她|别人)说|据说|听说", text):
        return "quoted"
    if re.search(r"可能|也许|不一定|大概", text):
        return "uncertain"
    if re.search(r"吹牛|你又开始吹|开玩笑|逗你|夸张", text):
        return "non_literal"
    if re.search(r"准备|计划|打算|想去", text):
        return "future_plan"
    return None


def decide_memory_action(
    output: Any,
    source_ids: set[str],
    texts: tuple[str, ...] | list[str] = (),
) -> dict[str, Any]:
    errors = validate_output(output, source_ids)
    if errors:
        return {
            "action": "blocked",
            "reason": "结构化输出不合约，停止自动流转。",
            "safety_flags": errors,
        }
    hard_cue = detect_hard_safety_cue(texts)
    if hard_cue == "retraction":
        return {
            "action": "invalidated",
            "reason": "原文包含明确的纠正、撤回或“那是吹牛”信号；相关旧候选必须失效。",
            "safety_flags": ["hard_cue:retraction"],
        }
    if hard_cue == "future_plan":
        return {
            "action": "plan_candidate",
            "reason": "原文包含明确的计划表达；即使模型字段误判，也不能当成当前事实。",
            "safety_flags": ["hard_cue:future_plan"],
        }
    if hard_cue in {"hypothetical", "quoted", "uncertain", "non_literal"}:
        return {
            "action": "pending",
            "reason": "原文包含强语用不确定信号；即使模型字段误判，也不能自动确认。",
            "safety_flags": [f"hard_cue:{hard_cue}"],
        }
    if (
        output["dialogue_act"] == "correction"
        or output["assertion_status"] == "retracted"
        or output["evidence_relation"] == "contradicts"
    ):
        return {
            "action": "invalidated",
            "reason": "检测到纠正、撤回或矛盾证据；相关旧候选必须失效。",
            "safety_flags": ["retraction"],
        }
    if (
        output["dialogue_act"] == "plan"
        and output["assertion_status"] == "planned"
        and output["time_status"] == "future"
    ):
        return {
            "action": "plan_candidate",
            "reason": "这是未来计划，不是已经发生的事实。",
            "safety_flags": ["future_plan"],
        }
    if (
        output["assertion_status"] in {"hypothetical", "quoted", "uncertain"}
        or output["literalness"] in {"ironic", "exaggerated", "non_literal"}
        or output["evidence_relation"] == "insufficient"
        or output["dialogue_act"] == "boast"
    ):
        return {
            "action": "pending",
            "reason": "语用状态不确定、存在引用/假设/夸张，或证据不足；不能自动确认。",
            "safety_flags": ["uncertain_pragmatics"],
        }
    if (
        output["assertion_status"] == "asserted"
        and output["literalness"] == "literal"
        and output["evidence_relation"] in {"direct", "supporting"}
    ):
        return {
            "action": "candidate",
            "reason": "字面陈述且有直接/支持性证据，可生成候选；仍不能自动变成 confirmed_memory。",
            "safety_flags": ["requires_adoption_gate"],
        }
    return {
        "action": "pending",
        "reason": "无法满足安全采纳条件，保留为待确认。",
        "safety_flags": ["default_safe_fallback"],
    }


def _tool_args(message: Any) -> dict[str, Any]:
    tool_calls = getattr(message, "tool_calls", None) or []
    if not tool_calls:
        raise RuntimeError("模型没有返回结构化工具调用")
    args = tool_calls[0].get("args")
    if isinstance(args, str):
        args = json.loads(args)
    if not isinstance(args, dict):
        raise RuntimeError("工具调用参数不是 JSON 对象")
    return args


def _build_model(api_key: str, model_name: str):
    try:
        from langchain_deepseek import ChatDeepSeek
    except ImportError as error:  # pragma: no cover - only used outside env
        raise RuntimeError(
            "当前 Python 环境没有 langchain-deepseek；请使用项目 NotAlone conda 环境。"
        ) from error

    options: dict[str, Any] = {
        "model": model_name,
        "api_key": api_key,
        "timeout": 60.0,
        "max_retries": 2,
        "temperature": 0.0,
        "extra_body": {"thinking": {"type": "disabled"}},
    }
    base_url = os.environ.get(BASE_URL_ENV)
    if base_url:
        options["base_url"] = base_url
    return ChatDeepSeek(**options)


def _load_project_env() -> str | None:
    """复用项目的受控 ``.env`` 加载器，不打印任何配置值。"""

    try:
        from notalone.runtime_config import load_project_env
    except ImportError as error:  # pragma: no cover - only used outside env
        raise RuntimeError(
            "当前 Python 环境无法导入项目运行配置；请使用项目 NotAlone conda 环境。"
        ) from error
    path = load_project_env()
    return str(path) if path is not None else None


def run_case(model: Any, case: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    bound = model.bind_tools([INTERPRETATION_SCHEMA])
    message = bound.invoke(
        [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": _window_text(case)},
        ]
    )
    output = _tool_args(message)
    texts = tuple(text for _, _, text in case["messages"])
    decision = decide_memory_action(output, _source_ids(case), texts)
    return output, decision


def _is_safety_violation(case: dict[str, Any], decision: dict[str, Any]) -> bool:
    action = decision["action"]
    if "confirmed_memory" in action:
        return True
    if case["expected"] == "invalidated":
        return action not in {"invalidated", "blocked"}
    if case["expected"] == "pending":
        return action not in {"pending", "invalidated", "blocked"}
    return False


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default=os.environ.get(MODEL_ENV) or MODEL_DEFAULT,
        help=f"DeepSeek 模型名，默认 {MODEL_DEFAULT}；也可用 {MODEL_ENV}",
    )
    return parser.parse_args()


def main() -> int:
    env_path = _load_project_env()
    args = parse_args()
    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        print(f"[skip] 未设置 {API_KEY_ENV}，没有发起网络请求。")
        print("[skip] 需要真实冒烟时，请在进程环境或项目 .env 中设置凭据后重跑；本脚本只发送合成案例。")
        return 0

    print(f"[config] env_file={'loaded' if env_path else 'not-found'} model={args.model} thinking=disabled temperature=0.0")
    print("[config] scope=synthetic-only persistence=none")
    model = _build_model(api_key, args.model)
    failures = 0
    safety_violations = 0
    for case in CASES:
        print(f"\n[case] {case['id']} expected={case['expected']}")
        try:
            output, decision = run_case(model, case)
        except Exception as error:  # noqa: BLE001 - smoke runner must show case failure
            failures += 1
            print(f"[error] {type(error).__name__}: {error}")
            continue
        safety_violation = _is_safety_violation(case, decision)
        safety_violations += int(safety_violation)
        print(f"[model] {json.dumps(output, ensure_ascii=False, sort_keys=True)}")
        print(f"[gate] action={decision['action']} reason={decision['reason']}")
        if decision["safety_flags"]:
            print(f"[gate] flags={','.join(decision['safety_flags'])}")
        if safety_violation:
            failures += 1
            print("[FAIL] 安全闸门允许了不应确认的动作。")
        elif decision["action"] != case["expected"]:
            print(f"[observe] 模型解释导致动作与预期不同：actual={decision['action']}")
        else:
            print("[PASS] 动作符合该合成案例的预期。")

    print(f"\n[summary] cases={len(CASES)} failures={failures} safety_violations={safety_violations}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

"""在冻结的匿名窗口上对照“产品来源核验提示”的基线臂与候选臂。

前提：`.env` 或环境变量提供可用的 ECNU key（`NOTALONE_DEEPSEEK_API_KEY`）。
只读取冻结计划中的公开输入，不读模型输出、真实聊天或留出数据；
原始返回写入仓库外私有目录。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import sys
from typing import Any

REPO = Path(__file__).resolve().parents[3]
PLAN = Path(__file__).resolve().parent / "frozen-plan-v1.json"
BASELINE_PROMPT_COMMIT = "e015b96"  # 产品提示加入单叶前的提交
PRIVATE_OUTPUT = Path("~/.notalone/audits/product-prompt-comparison-20261004").expanduser()


def _load_baseline_prompt() -> str:
    """从 git 取改动前的产品提示，避免在材料里留一份会漂移的副本。"""

    source = subprocess.run(
        [
            "git", "show",
            f"{BASELINE_PROMPT_COMMIT}:src/notalone/memory_extraction/verification_adapters.py",
        ],
        cwd=REPO, check=True, capture_output=True, text=True,
    ).stdout
    namespace: dict[str, Any] = {}
    exec(compile(source, "baseline", "exec"), namespace)  # noqa: S102 - 只读仓库内源码
    prompt = namespace["SOURCE_VERIFICATION_SYSTEM_PROMPT"]
    if not isinstance(prompt, str) or not prompt.strip():
        raise RuntimeError("基线提示读取失败。")
    return prompt


def _candidate_prompt() -> str:
    sys.path.insert(0, str(REPO / "src"))
    from notalone.memory_extraction.verification_adapters import (
        SOURCE_VERIFICATION_SYSTEM_PROMPT,
    )

    return SOURCE_VERIFICATION_SYSTEM_PROMPT


def _invoke(model: Any, schema: dict[str, Any], prompt: str, messages: object) -> Any:
    """优先钉扎结构化工具；端点不支持时退回普通工具选择并留证。"""

    payload = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": messages},
    ]
    try:
        bound = model.bind_tools([schema], tool_choice=schema["title"])
        return bound.invoke(payload)
    except Exception as error:  # noqa: BLE001 - 端点能力差异要留证据
        print(f"  钉扎工具失败（{type(error).__name__}），退回默认工具选择")
        return model.bind_tools([schema]).invoke(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="产品核验提示匿名对照")
    parser.add_argument("--output", type=Path, default=PRIVATE_OUTPUT)
    parser.add_argument("--dry-run", action="store_true", help="只检查前提，不联网")
    args = parser.parse_args()

    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    baseline = _load_baseline_prompt()
    candidate = _candidate_prompt()
    if baseline == candidate:
        print("基线提示与候选提示相同，无法形成对照。")
        return 1

    sys.path.insert(0, str(REPO / "src"))
    from notalone.memory_extraction.verification_adapters import (
        SOURCE_VERIFICATION_SCHEMA,
    )

    windows = plan["windows"]
    preflight = {
        "kind": "product-prompt-comparison-preflight-v1",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "baseline_prompt_sha256": hashlib.sha256(baseline.encode()).hexdigest(),
        "candidate_prompt_sha256": hashlib.sha256(candidate.encode()).hexdigest(),
        "schema_sha256": hashlib.sha256(
            json.dumps(SOURCE_VERIFICATION_SCHEMA, sort_keys=True).encode()
        ).hexdigest(),
        "endpoint_host": "chat.ecnu.edu.cn",
        "key_fingerprint_sha256": hashlib.sha256(key.encode()).hexdigest()[:16]
        if (key := os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "").strip()) else None,
        "windows": [entry["input_sha256"] for entry in windows],
        "max_public_invokes": plan["scope"]["max_public_invokes"],
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "preflight-v1.json").write_text(
        json.dumps(preflight, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    print("预检已写入；基线提示与候选提示不同。")
    if args.dry_run:
        return 0

    from notalone.runtime_config import load_project_env

    load_project_env()
    key = os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "").strip()
    if not key:
        print("缺少 NOTALONE_DEEPSEEK_API_KEY：请在 .env 或环境变量提供可用 ECNU key。")
        return 1

    from notalone.reply.adapters.deepseek_provider import build_deepseek_model

    model = build_deepseek_model(
        model_name=plan["scope"]["model"],
        extra_body={"thinking": {"type": "enabled"}},
    )
    results: list[dict[str, Any]] = []
    for index, window in enumerate(windows, start=1):
        source = json.loads(
            Path(window["input_path"]).expanduser().read_text(encoding="utf-8")
        )
        messages = source.get("public_invoke_messages")
        if not isinstance(messages, list) or len(messages) != 2:
            print(f"窗口 {index} 的冻结输入结构异常。")
            return 1
        # 只复用冻结输入里的 user 消息；system 与工具 schema 用产品当前版本，
        # 这样两臂的差异只在提示本身。
        user_message = messages[1]["content"]
        for arm, prompt in (("baseline", baseline), ("candidate", candidate)):
            response = _invoke(model, SOURCE_VERIFICATION_SCHEMA, prompt, user_message)
            calls = getattr(response, "tool_calls", None) or []
            payload = calls[0]["args"] if calls else None
            record = {
                "window": index,
                "input_sha256": window["input_sha256"],
                "arm": arm,
                "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
                "tool_calls": len(calls),
                "payload": payload,
                "usage": getattr(response, "usage_metadata", None),
            }
            results.append(record)
            (args.output / f"r{index}-{arm}-V-response.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=2, default=str) + "\n",
                encoding="utf-8",
            )
            print(f"窗口 {index} {arm}: verdict={payload['results'][0]['verdict'] if payload else 'none'}")
    (args.output / "summary.json").write_text(
        json.dumps({"invokes": len(results), "results": results}, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    print(f"完成 {len(results)} 次调用，原始返回在 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

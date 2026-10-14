"""冻结原公开六窗的 grounded-v1 请求，并复用生产编译器检查真实返回。"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from typing import Any

from compare_tencent_extraction import CASE_IDS, ROOT, ENDPOINT, digest, save
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
from notalone.memory_extraction.grounded import compile_draft
from notalone.memory_extraction.grounded_adapter import GROUNDED_PROMPT, GROUNDED_SCHEMA, grounded_input


def cases() -> tuple[bytes, list[tuple[dict[str, Any], Any]]]:
    raw = (ROOT / ".scratch/unfinished-work/memory-gold-reference-20261012.json").read_bytes()
    reference = json.loads(raw)
    selected = []
    for identity in CASE_IDS:
        gold = next(item for item in reference["windows"] if item["id"] == identity)
        case = next(item for item in _PLAN_CASES if item.name == gold["case_name"])
        selected.append((gold, build_window(case)))
    return raw, selected


def prepare(output: Path) -> None:
    raw, selected = cases()
    schema = dict(GROUNDED_SCHEMA)
    title = schema.pop("title")
    description = schema.pop("description")
    jobs = []
    for gold, window in selected:
        jobs.append({"case_id": gold["id"], "arm": "grounded-v1", "request": {
            "temperature": 0.0, "stream": False, "thinking": {"type": "enabled"},
            "messages": [{"role": "system", "content": GROUNDED_PROMPT},
                         {"role": "user", "content": grounded_input(window)}],
            "tools": [{"type": "function", "function": {
                "name": title, "description": description, "parameters": schema,
            }}],
        }})
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    save(output / "plan.json", {
        "scope": "同一公开六窗、原Gold；一次结构提取；无V与业务写入；零重试",
        "cap": 6, "retry": 0, "endpoint": ENDPOINT,
        "reference_sha256": digest(raw), "reference": [gold for gold, _ in selected],
        "runner_sha256": digest((ROOT / "scripts/compare_tencent_extraction.py").read_bytes()),
        "compiler_sha256": digest((ROOT / "backend/src/notalone/memory_extraction/grounded.py").read_bytes()),
        "jobs": jobs,
    })


def compile_results(output: Path, *, recompile: bool = False) -> None:
    raw, selected = cases()
    plan = json.loads((output / "plan.json").read_text())
    compiler_sha = digest((ROOT / "backend/src/notalone/memory_extraction/grounded.py").read_bytes())
    if (plan["reference_sha256"] != digest(raw)
            or (not recompile and plan["compiler_sha256"] != compiler_sha)):
        raise ValueError("参考或编译器已改变，不能覆盖原场结果")
    results = []
    for index, (gold, window) in enumerate(selected):
        path = output / f"{index:02}-response.json"
        if not path.exists():
            results.append({"case_id": gold["id"], "status": "not_returned"})
            continue
        response = json.loads(path.read_text())
        try:
            calls = response["choices"][0]["message"].get("tool_calls", [])
            if len(calls) != 1 or calls[0]["function"]["name"] != GROUNDED_SCHEMA["title"]:
                raise ValueError("结构工具不匹配")
            draft = json.loads(calls[0]["function"]["arguments"])
            facts = compile_draft(window, draft)
            results.append({"case_id": gold["id"], "status": "compiled", "facts": facts})
        except (ValueError, RuntimeError, KeyError, TypeError) as error:
            results.append({"case_id": gold["id"], "status": "invalid", "error": str(error)})
    target = output / (f"recompiled-{compiler_sha[:16]}.json" if recompile else "compiled.json")
    save(target, {"compiler_sha256": compiler_sha, "original_compiler_sha256": plan["compiler_sha256"],
                  "new_model_calls": 0, "results": results})
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "compile"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--recompile", action="store_true")
    args = parser.parse_args()
    if args.mode == "prepare":
        if args.recompile:
            parser.error("prepare不能重编译")
        prepare(args.output)
    else:
        compile_results(args.output, recompile=args.recompile)

"""固定公开六窗口的提取层对照；不接业务库，不评自动采纳，不重试。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

from notalone.memory_extraction.adapters import (
    EXTRACTION_SCHEMA, EXTRACTION_SYSTEM_PROMPT, _window_text,
)
from notalone.memory_extraction.evaluation import build_window
from notalone.memory_extraction.evaluation_ecnu import _PLAN_CASES
from notalone.runtime_config import load_project_env


ROOT = Path(__file__).resolve().parents[1]
UPSTREAM = "fb0610ee19287a58a96d4b6ffae803aa581d53de"
CASE_IDS = ("A01", "A02", "A05", "A06", "B01", "B02")
ENDPOINT = "https://chat.ecnu.edu.cn/open/api/v1/chat/completions"


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def save(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
    path.chmod(0o600)


def prepare(output: Path, upstream_path: Path) -> None:
    reference_path = ROOT / ".scratch/unfinished-work/memory-gold-reference-20261012.json"
    reference_bytes = reference_path.read_bytes()
    reference = json.loads(reference_bytes)
    upstream_bytes = upstream_path.read_bytes()
    match = re.search(
        r"export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `([\s\S]*?)`;",
        upstream_bytes.decode(),
    )
    if match is None:
        raise ValueError("缺少腾讯原始提取提示")
    tencent_prompt = match[1].replace("\\`", "`")
    schema = dict(EXTRACTION_SCHEMA)
    title = schema.pop("title")
    description = schema.pop("description", "")
    tool = {"type": "function", "function": {
        "name": title, "description": description, "parameters": schema,
    }}
    jobs = []
    selected_reference = []
    for ordinal, case_id in enumerate(CASE_IDS):
        gold = next(item for item in reference["windows"] if item["id"] == case_id)
        case = next(item for item in _PLAN_CASES if item.name == gold["case_name"])
        window = build_window(case)
        selected_reference.append(gold)
        background: list[str] = []
        new: list[str] = []
        for message in window.messages:
            if message.occurred_at is None:
                raise ValueError("固定公开窗口缺少时间")
            # 双方都是真人；不能把 owner 假冒为 AI。保留原 ID、时间与发送者。
            line = (f"[{message.message_id}] [user; sender={message.sender.value}] "
                    f"[{message.occurred_at.isoformat()}]: {message.text}")
            (new if message.message_id in window.target_message_id_set else background).append(line)
        tencent_input = (
            "时区沿消息自带偏移；contact=联系人，self=用户本人，两者都是真人。\n"
            "【上一个情境】：无\n【背景对话】（仅供理解，严禁从中提取记忆）：\n"
            + "\n\n".join(background) + "\n【待提取的新消息】：\n" + "\n\n".join(new)
        )
        arms = ("notalone", "tencent") if ordinal % 2 == 0 else ("tencent", "notalone")
        for arm in arms:
            request = {
                "temperature": 0.0, "stream": False, "thinking": {"type": "enabled"},
                "messages": [
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT if arm == "notalone" else tencent_prompt},
                    {"role": "user", "content": _window_text(window) if arm == "notalone" else tencent_input},
                ],
            }
            if arm == "notalone":
                request.update(tools=[tool], tool_choice={"type": "function", "function": {"name": title}})
            jobs.append({"case_id": case_id, "arm": arm, "request": request})
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    save(output / "plan.json", {
        "scope": "公开合成六窗；各臂一次；只比较提取，非腾讯完整系统或产品端到端",
        "cap": 12, "retry": 0, "endpoint": ENDPOINT, "upstream_commit": UPSTREAM,
        "upstream_sha256": digest(upstream_bytes), "reference_sha256": digest(reference_bytes),
        "runner_sha256": digest(Path(__file__).read_bytes()),
        "reference": selected_reference, "jobs": jobs,
    })
    print("prepared: 6 windows, 12 requests, 0 model calls", flush=True)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def run(output: Path) -> None:
    plan_bytes = (output / "plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    if (not 1 <= plan["cap"] <= 12 or len(plan["jobs"]) != plan["cap"] or plan["endpoint"] != ENDPOINT
            or plan["runner_sha256"] != digest(Path(__file__).read_bytes())):
        raise ValueError("冻结计划不一致")
    # 独占启动收据：进程失败也不得重开同场或补位。
    save(output / "started.json", {"plan_sha256": digest(plan_bytes), "time": time.time()})
    load_project_env()
    base = os.environ["NOTALONE_DEEPSEEK_BASE_URL"].rstrip("/")
    if base + "/chat/completions" != ENDPOINT:
        raise ValueError("只允许既有 ECNU 端点")
    key = os.environ["NOTALONE_DEEPSEEK_API_KEY"]
    model = os.environ.get("NOTALONE_DEEPSEEK_MODEL", "ecnu-max")
    opener = urllib.request.build_opener(NoRedirect)
    attempts = 0
    try:
        for index, job in enumerate(plan["jobs"]):
            request = {**job["request"], "model": model}
            save(output / f"{index:02d}-request.json", request)
            save(output / f"{index:02d}-reserved.json", {"case_id": job["case_id"], "arm": job["arm"]})
            attempts += 1
            started = time.monotonic()
            print(f"start {index + 1}/{plan['cap']} {job['case_id']} {job['arm']}", flush=True)
            wire = urllib.request.Request(ENDPOINT, data=json.dumps(request).encode(), headers={
                "Authorization": "Bearer " + key, "Content-Type": "application/json",
            })
            try:
                with opener.open(wire, timeout=300) as response:
                    result = json.load(response)
                save(output / f"{index:02d}-response.json", result)
                save(output / f"{index:02d}-receipt.json", {
                    "status": "returned", "seconds": time.monotonic() - started,
                    "model": result.get("model"), "usage": result.get("usage"),
                })
                print(f"returned {index + 1}/{plan['cap']} model={result.get('model')}", flush=True)
            except Exception as error:
                save(output / f"{index:02d}-error.json", {
                    "type": type(error).__name__, "seconds": time.monotonic() - started,
                    "http_status": error.code if isinstance(error, urllib.error.HTTPError) else None,
                    "remote_completion": "unknown", "retry": False,
                })
                print("request failed; no retry", flush=True)
                if not isinstance(error, urllib.error.HTTPError):
                    break
    finally:
        save(output / "closed.json", {"attempts": attempts, "unused_closed": plan["cap"] - attempts})


def continue_unattempted(output: Path) -> None:
    """首场技术停止后只执行未发出的原计划位置；失败位置绝不重试。"""
    plan_bytes = (output / "plan.json").read_bytes()
    started = json.loads((output / "started.json").read_text())
    if digest(plan_bytes) != started["plan_sha256"]:
        raise ValueError("首场冻结计划被修改")
    plan = json.loads(plan_bytes)
    closed = json.loads((output / "closed.json").read_text())
    if plan["cap"] != 12 or closed["attempts"] != 1:
        raise ValueError("仅允许当前首场一次失败后的未发送位置")
    save(output / "continuation.json", {"skip_attempted": 1, "remaining": 11})
    remaining = output / "remaining"
    remaining.mkdir(mode=0o700)
    save(remaining / "plan.json", {
        **plan, "cap": 11, "jobs": plan["jobs"][1:],
        "parent_plan_sha256": digest(plan_bytes),
        "runner_sha256": digest(Path(__file__).read_bytes()),
    })
    run(remaining)


def compatible_baseline(output: Path) -> None:
    """独立六次兼容变体；保留提示/schema，只省略强制工具选择。"""
    plan_bytes = (output / "plan.json").read_bytes()
    started = json.loads((output / "started.json").read_text())
    if digest(plan_bytes) != started["plan_sha256"]:
        raise ValueError("首场冻结计划被修改")
    plan = json.loads(plan_bytes)
    jobs = []
    for job in plan["jobs"]:
        if job["arm"] == "notalone":
            request = dict(job["request"])
            del request["tool_choice"]
            jobs.append({**job, "arm": "notalone_compatible", "request": request})
    variant = output / "compatible"
    variant.mkdir(mode=0o700)
    save(variant / "plan.json", {
        **plan, "cap": 6, "jobs": jobs,
        "scope": "独立六次兼容对照；不等于生产强制工具协议已通过",
        "parent_plan_sha256": digest(plan_bytes),
        "runner_sha256": digest(Path(__file__).read_bytes()),
    })
    run(variant)


def _without_descriptions(value: object) -> object:
    """字段说明可改，工具的结构合同不得在复测中静默变化。"""
    if isinstance(value, dict):
        return {key: _without_descriptions(item) for key, item in value.items()
                if key != "description"}
    if isinstance(value, list):
        return [_without_descriptions(item) for item in value]
    return value


def prepare_repair(output: Path, baseline: Path) -> None:
    """沿冻结公开六窗准备修复复测；只改提示与字段说明，不发送请求。"""
    plan_bytes = (baseline / "plan.json").read_bytes()
    plan = json.loads(plan_bytes)
    reference_bytes = (ROOT / ".scratch/unfinished-work/memory-gold-reference-20261012.json").read_bytes()
    reference = json.loads(reference_bytes)
    if (plan.get("reference_sha256") != digest(reference_bytes)
            or plan.get("endpoint") != ENDPOINT
            or [job["case_id"] for job in plan["jobs"]] != list(CASE_IDS)):
        raise ValueError("只允许原公开六窗及未变更的参考")
    schema = dict(EXTRACTION_SCHEMA)
    title = schema.pop("title")
    description = schema.pop("description", "")
    jobs = []
    for job in plan["jobs"]:
        gold = next(item for item in reference["windows"] if item["id"] == job["case_id"])
        case = next(item for item in _PLAN_CASES if item.name == gold["case_name"])
        user_message = {"role": "user", "content": _window_text(build_window(case))}
        request = job["request"]
        expected = {
            "temperature": 0.0, "stream": False, "thinking": {"type": "enabled"},
            "messages": [request["messages"][0], user_message],
            "tools": [{"type": "function", "function": {
                "name": title, "description": description, "parameters": schema,
            }}],
        }
        if _without_descriptions(request) != _without_descriptions(expected):
            raise ValueError("基线输入、schema或兼容协议不一致")
        jobs.append({**job, "arm": "notalone_repair", "request": {
            **expected, "messages": [
                {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT}, user_message,
            ],
        }})
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    save(output / "plan.json", {
        **plan, "jobs": jobs, "cap": 6,
        "scope": "原六公开窗口与判据；仅替换提取提示与字段说明；兼容工具协议，非完整入库验收",
        "parent_plan_sha256": digest(plan_bytes),
        "runner_sha256": digest(Path(__file__).read_bytes()),
    })
    print("prepared: 6 public windows, 6 requests, 0 model calls", flush=True)


def corrected_tencent(output: Path) -> None:
    """独立修正输入身份说明；不改变消息内容、目标或腾讯系统提示。"""
    plan_bytes = (output / "plan.json").read_bytes()
    started = json.loads((output / "started.json").read_text())
    if digest(plan_bytes) != started["plan_sha256"]:
        raise ValueError("首场冻结计划被修改")
    plan = json.loads(plan_bytes)
    jobs = []
    for job in plan["jobs"]:
        if job["arm"] == "tencent":
            request = dict(job["request"])
            messages = [dict(message) for message in request["messages"]]
            messages[1]["content"] = messages[1]["content"].replace("owner=用户本人", "self=用户本人")
            request["messages"] = messages
            jobs.append({**job, "arm": "tencent_corrected", "request": request})
    variant = output / "corrected-tencent"
    variant.mkdir(mode=0o700)
    save(variant / "plan.json", {
        **plan, "cap": 6, "jobs": jobs,
        "scope": "纠正sender说明的独立六次；旧适配缺陷结果保留，不替换原输出",
        "parent_plan_sha256": digest(plan_bytes),
        "runner_sha256": digest(Path(__file__).read_bytes()),
    })
    run(variant)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "prepare-repair", "run", "continue-unattempted", "compatible", "corrected-tencent"))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--upstream", type=Path)
    parser.add_argument("--baseline", type=Path)
    args = parser.parse_args()
    if args.mode == "prepare":
        if args.upstream is None:
            parser.error("prepare 需要 --upstream")
        prepare(args.output, args.upstream)
    elif args.mode == "prepare-repair":
        if args.baseline is None:
            parser.error("prepare-repair 需要 --baseline")
        prepare_repair(args.output, args.baseline)
    elif args.mode == "run":
        run(args.output)
    elif args.mode == "continue-unattempted":
        continue_unattempted(args.output)
    elif args.mode == "compatible":
        compatible_baseline(args.output)
    else:
        corrected_tencent(args.output)

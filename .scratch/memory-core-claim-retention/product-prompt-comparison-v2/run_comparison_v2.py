"""票 01「记忆核心事实保留」重复测量对照 runner（v2）。

复用 v1 的 `_load_baseline_prompt`／`_candidate_prompt`／`_invoke` 形状，增加：
重复位置（2 窗口 × 4 重复）、冻结臂序轮换表、分阶段门、失败与空返回计入分母、
以及“阶段 1 判败即永久关闭阶段 2”。

边界：
- `--dry-run` 在读取任何凭据之前返回：不读 `.env`、不读环境变量里的 key、
  不构造模型客户端、不联网；只加载并校验冻结计划、核对两臂提示 SHA、
  构造两臂请求、打印 16 个位置与顺序、写 dry-run 记录。
- 真实运行路径先写预算预约记录，再逐位置调用；失败与空返回照计分母且**不重跑**。
- 原始返回与逐位置审计只写入仓库外私有目录（目录 0700、文件 0600），不入 Git。
- 只读冻结计划里登记的两个匿名窗口公开输入；不读真实聊天、`chat_exports/`
  或 actual／held 留出数据；不写业务数据；不改 `src/` 产品源码。
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PLAN_PATH = HERE / "frozen-plan-v2.json"
BASELINE_PROMPT_COMMIT = "e015b96"
PROMPT_SOURCE_PATH = "src/notalone/memory_extraction/verification_adapters.py"
DEFAULT_OUTPUT = Path("~/.notalone/audits/memory-claim-retention-repetition-20261005").expanduser()
PRIVATE_DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600
ECNU_ENDPOINT_HOST = "chat.ecnu.edu.cn"
DEFAULT_BASE_URL = "https://chat.ecnu.edu.cn/open/api/v1"
OFFICIAL_ENDPOINT_HOSTS = frozenset({"api.deepseek.com"})
API_KEY_ENV_VAR = "NOTALONE_DEEPSEEK_API_KEY"
BASE_URL_ENV_VAR = "NOTALONE_DEEPSEEK_BASE_URL"

EXPECTED_ORDER_TABLE: tuple[tuple[int, int, str, str], ...] = (
    (1, 1, "W1", "baseline-first"),
    (2, 1, "W2", "candidate-first"),
    (3, 2, "W1", "candidate-first"),
    (4, 2, "W2", "baseline-first"),
    (5, 3, "W1", "baseline-first"),
    (6, 3, "W2", "candidate-first"),
    (7, 4, "W1", "candidate-first"),
    (8, 4, "W2", "baseline-first"),
)
SEMANTIC_VERDICTS = ("supported", "uncertain", "unsupported")
DOWNGRADE_VERDICTS = ("uncertain", "unsupported")
ARMS = ("baseline", "candidate")


class PlanError(RuntimeError):
    """冻结计划不完整、自相矛盾或与提案不一致。"""


# ---------------------------------------------------------------------------
# 冻结计划加载与校验
# ---------------------------------------------------------------------------


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return _sha256_bytes(text.encode("utf-8"))


def canonical_json_sha256(value: object) -> str:
    """统一口径的 JSON 规范化 SHA256（prepare 与 runner 共用同一实现）。

    规范化是 `json.dumps(value, ensure_ascii=False, sort_keys=True,
    separators=(",", ":"))` 后按 UTF-8 取 SHA256：保留中文原文、按键排序、
    无多余空白。冻结计划里的 `sources.schema_sha256` 必须用本函数重算，
    不允许 prepare 与 runner 各用一套 `ensure_ascii` 口径。
    """

    normalized = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return _sha256_text(normalized)


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_plan(path: Path | None = None) -> dict[str, Any]:
    """加载冻结计划并校验全部不变量。"""

    plan_path = path or PLAN_PATH
    if not plan_path.is_file():
        raise PlanError(f"缺少冻结计划：{plan_path}")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict):
        raise PlanError("冻结计划必须是 JSON 对象。")
    validate_plan(plan)
    return plan


def validate_plan(plan: dict[str, Any]) -> None:
    """校验冻结计划：规模、预算、阶段、臂序轮换与边界。"""

    if plan.get("kind") != (
        "memory-core-claim-retention-product-prompt-repetition-comparison-v2"
    ):
        raise PlanError("冻结计划 kind 不符。")
    if plan.get("status") != "prepared-pending-credential":
        raise PlanError("冻结计划必须先处于 prepared-pending-credential。")

    scope = plan.get("scope") or {}
    budget = plan.get("budget") or {}
    if scope.get("windows") != 2 or scope.get("repeats") != 4 or scope.get("arms_count") != 2:
        raise PlanError("冻结计划的窗口数／重复数／臂数不是 2 × 4 × 2。")
    if (budget.get("max_public_invokes"), budget.get("E"), budget.get("V"),
            budget.get("R")) != (16, 0, 16, 0):
        raise PlanError("预算不是 16 次公开调用，或 E／V／R 拆分不是 0／16／0。")
    if (budget.get("phase1_invokes"), budget.get("phase2_invokes")) != (8, 8):
        raise PlanError("阶段预算不是 8 + 8。")
    if budget.get("phase2_closes_permanently_if_phase1_fails") is not True:
        raise PlanError("阶段 1 判败必须永久关闭阶段 2。")
    if budget.get("failure_and_empty_still_count") is not True:
        raise PlanError("失败与空返回必须计入分母。")
    if budget.get("no_retry_no_backfill_no_extra_arm") is not True:
        raise PlanError("必须禁止重跑、补位与加臂。")
    if scope.get("model") != "ecnu-max":
        raise PlanError("只允许现有 ECNU ecnu-max。")
    if scope.get("official_deepseek_endpoint_or_key") is not False:
        raise PlanError("不得使用官方 key 或官方端点。")
    if scope.get("fallback_provider") != "none":
        raise PlanError("不得设置回退供应商。")
    if ECNU_ENDPOINT_HOST not in str(scope.get("provider", "")):
        raise PlanError("供应方必须是既有 ECNU 端点。")

    boundaries = plan.get("boundaries") or {}
    for key in (
        "reads_real_chat", "reads_actual_or_held_holdout", "reads_other_contacts",
        "reads_credentials_during_dry_run",
        "writes_business_memory_watermark_or_product_default",
        "changes_product_source", "changes_existing_ticket_state_or_triage",
        "remote_git_operations",
    ):
        if boundaries.get(key) is not False:
            raise PlanError(f"边界 {key} 必须为 false。")

    windows = plan.get("windows") or []
    if len(windows) != 2:
        raise PlanError("冻结计划必须登记 2 个窗口。")
    for index, window in enumerate(windows, start=1):
        if window.get("window_id") != f"W{index}":
            raise PlanError("窗口标识与顺序不一致。")
        if not isinstance(window.get("input_sha256"), str) or len(
            window["input_sha256"]
        ) != 64:
            raise PlanError("窗口输入 SHA 缺失或格式不符。")
        if Path(str(window.get("input_path", ""))).is_relative_to(REPO):
            raise PlanError("冻结输入不得位于仓库内。")

    arms_detail = ((scope.get("arms_detail") or {}))
    for arm in ARMS:
        detail = arms_detail.get(arm) or {}
        for key in ("prompt_file_sha256", "prompt_body_sha256"):
            if not isinstance(detail.get(key), str) or len(detail[key]) != 64:
                raise PlanError(f"{arm} 臂必须记录 {key}。")

    sources = plan.get("sources") or {}
    for key in ("runner_script", "runner_script_sha256",
                "prepare_script", "prepare_script_sha256", "schema_sha256"):
        if not isinstance(sources.get(key), str) or not sources[key]:
            raise PlanError(f"冻结计划必须记录 sources.{key}。")
    for key in ("runner_script_sha256", "prepare_script_sha256",
                "schema_sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", sources[key]):
            raise PlanError(f"sources.{key} 必须是 64 位小写十六进制 SHA256。")

    _validate_schedule(plan)


def _validate_schedule(plan: dict[str, Any]) -> None:
    schedule = plan.get("schedule") or {}
    slots = schedule.get("slots") or []
    if len(slots) != len(EXPECTED_ORDER_TABLE):
        raise PlanError("顺序表不是 8 个「窗口 × 重复」位置。")
    observed = tuple(
        (slot.get("exec_order"), int(str(slot.get("repeat", "r0"))[1:]),
         slot.get("window_id"), slot.get("arm_order"))
        for slot in slots
    )
    if observed != EXPECTED_ORDER_TABLE:
        raise PlanError(f"顺序表与提案第 2.2 节不一致：{observed}")

    for slot in slots:
        window_rank = int(str(slot["window_id"])[1:])
        repeat = int(str(slot["repeat"])[1:])
        expected_first = "baseline" if (window_rank + repeat) % 2 == 0 else "candidate"
        if slot.get("first_arm") != expected_first:
            raise PlanError(f"执行序 {slot['exec_order']} 的臂序违反轮换规则。")
        if slot.get("arms") != [expected_first, "candidate" if expected_first == "baseline" else "baseline"]:
            raise PlanError(f"执行序 {slot['exec_order']} 的臂序表不符。")
        if slot.get("invokes") != 2:
            raise PlanError(f"执行序 {slot['exec_order']} 的次数不是 2。")
        expected_phase = 1 if repeat <= 2 else 2
        if slot.get("phase") != expected_phase:
            raise PlanError(f"执行序 {slot['exec_order']} 的阶段划分不符。")

    counts = {"baseline": 0, "candidate": 0}
    per_window: dict[str, dict[str, int]] = {
        window["window_id"]: {"baseline": 0, "candidate": 0}
        for window in plan["windows"]
    }
    for slot in slots:
        counts[slot["first_arm"]] += 1
        per_window[slot["window_id"]][slot["first_arm"]] += 1
    if counts != {"baseline": 4, "candidate": 4}:
        raise PlanError(f"臂序轮换不是 4/4 平衡：{counts}")
    for window_id, window_counts in per_window.items():
        if window_counts != {"baseline": 2, "candidate": 2}:
            raise PlanError(f"{window_id} 的臂序不是 2/2 平衡：{window_counts}")

    invocations = schedule.get("invocations") or []
    if len(invocations) != 16:
        raise PlanError("顺序表展开的调用数不是 16。")
    if [entry.get("sequence") for entry in invocations] != list(range(1, 17)):
        raise PlanError("调用序号不是 1..16。")
    for arm in ARMS:
        if sum(1 for entry in invocations if entry.get("arm") == arm) != 8:
            raise PlanError(f"{arm} 臂的位置数不是 8。")
        for window_id in per_window:
            window_arm = [
                entry for entry in invocations
                if entry.get("arm") == arm and entry.get("window_id") == window_id
            ]
            if len(window_arm) != 4:
                raise PlanError(f"{arm} 臂在 {window_id} 的位置数不是 4。")
    for phase, repeats in ((1, {"r1", "r2"}), (2, {"r3", "r4"})):
        phase_entries = [
            entry for entry in invocations if entry.get("phase") == phase
        ]
        if len(phase_entries) != 8:
            raise PlanError(f"阶段 {phase} 的调用数不是 8。")
        if {entry.get("repeat") for entry in phase_entries} != repeats:
            raise PlanError(f"阶段 {phase} 的重复轮次不符。")
    pairs = [(entry.get("slot_id"), entry.get("arm")) for entry in invocations]
    if len(pairs) != len(set(pairs)):
        raise PlanError("同一个位置被安排了重复调用。")

    gates = plan.get("gates") or {}
    phase1_gates = ((gates.get("phase1") or {}).get("checks") or {})
    for name in ("G1-a", "G1-b", "G1-c"):
        if name not in phase1_gates:
            raise PlanError(f"缺少阶段 1 门槛 {name}。")
    phase2_gates = gates.get("phase2") or {}
    for name in ("safety_gate", "runtime_gate", "main_judgment"):
        if name not in phase2_gates:
            raise PlanError(f"缺少阶段 2 门槛 {name}。")
    if phase1_gates["G1-c"]["threshold"]["candidate_max"] != 1:
        raise PlanError("G1-c 的候选上限必须是 1。")
    if phase1_gates["G1-a"]["threshold"]["structurally_valid"] != 8:
        raise PlanError("G1-a 必须是 8/8 结构合法。")
    if phase2_gates["safety_gate"]["threshold"]["pending"] != 16:
        raise PlanError("阶段 2 安全门的 pending 必须是 16/16。")


# ---------------------------------------------------------------------------
# 两臂提示：基线从 git 取，候选取当前仓库
# ---------------------------------------------------------------------------


def _load_baseline_prompt() -> str:
    """从 git 取改动前的产品提示，避免在材料里留一份会漂移的副本。"""

    source = subprocess.run(
        ["git", "show", f"{BASELINE_PROMPT_COMMIT}:{PROMPT_SOURCE_PATH}"],
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


def arm_prompts(plan: dict[str, Any]) -> dict[str, str]:
    """返回两臂的 system 提示正文。"""

    if plan.get("kind") is None:
        raise PlanError("冻结计划不完整。")
    return {"baseline": _load_baseline_prompt(), "candidate": _candidate_prompt()}


def check_prompt_integrity(plan: dict[str, Any]) -> dict[str, dict[str, str]]:
    """重算两臂的提示文件 SHA256 与提示正文 SHA256，与冻结计划核对。"""

    prompts = arm_prompts(plan)
    if prompts["baseline"] == prompts["candidate"]:
        raise PlanError("基线提示与候选提示相同，无法形成对照。")

    candidate_file_sha = _sha256_bytes((REPO / PROMPT_SOURCE_PATH).read_bytes())
    baseline_file_sha = _sha256_text(subprocess.run(
        ["git", "show", f"{BASELINE_PROMPT_COMMIT}:{PROMPT_SOURCE_PATH}"],
        cwd=REPO, check=True, capture_output=True, text=True,
    ).stdout)
    result: dict[str, dict[str, str]] = {
        "baseline": {
            "prompt_file_sha256": baseline_file_sha,
            "prompt_body_sha256": _sha256_text(prompts["baseline"]),
            "prompt_source": f"git {BASELINE_PROMPT_COMMIT}:{PROMPT_SOURCE_PATH}",
        },
        "candidate": {
            "prompt_file_sha256": candidate_file_sha,
            "prompt_body_sha256": _sha256_text(prompts["candidate"]),
            "prompt_source": f"{PROMPT_SOURCE_PATH} (working tree)",
        },
    }
    detail = plan["scope"]["arms_detail"]
    for arm in ARMS:
        for key in ("prompt_file_sha256", "prompt_body_sha256"):
            recorded = detail[arm][key]
            observed = result[arm][key]
            if observed != recorded:
                raise PlanError(
                    f"{arm} 臂的 {key} 与冻结计划不一致：{observed} != {recorded}"
                )
    return result


# ---------------------------------------------------------------------------
# 运行源码与 schema 完整性（提案第 4 节要求冻结运行源码）
# ---------------------------------------------------------------------------

# 计划里登记的脚本路径都以仓库根为基准；这些路径不得指向仓库外。
_SOURCE_KEYS = (
    ("runner_script", "runner_script_sha256", "runner"),
    ("prepare_script", "prepare_script_sha256", "prepare"),
)


def _resolve_repo_path(recorded: str) -> Path:
    """把计划里登记的仓库相对路径解析成绝对路径，并拒绝越出仓库。"""

    candidate = Path(recorded)
    if candidate.is_absolute():
        raise PlanError(f"运行源码路径必须是仓库相对路径：{recorded}")
    resolved = (REPO / candidate).resolve()
    if not resolved.is_relative_to(REPO.resolve()):
        raise PlanError(f"运行源码路径越出仓库：{recorded}")
    return resolved


def check_source_integrity(plan: dict[str, Any]) -> dict[str, Any]:
    """重算 runner 与 prepare 的 SHA256，与冻结计划逐项核对。

    按字节哈希（`sha256` × 文件原始字节），不含任何编码转换；计划记录的路径
    必须是仓库内相对路径。
    """

    sources = plan["sources"]
    observed: dict[str, Any] = {}
    for path_key, sha_key, label in _SOURCE_KEYS:
        path = _resolve_repo_path(sources[path_key])
        if not path.is_file():
            raise PlanError(f"运行源码不存在：{label} {path}")
        digest = _sha256_bytes(path.read_bytes())
        recorded = sources[sha_key]
        if digest != recorded:
            raise PlanError(
                f"运行源码 {label} 的 SHA256 与冻结计划不一致："
                f"{digest} != {recorded}（{path}）"
            )
        observed[path_key] = str(path)
        observed[sha_key] = digest
        observed[f"{sha_key}_method"] = "文件原始字节 sha256（UTF-8 无关）"
    return observed


def compute_schema_sha256() -> str:
    """统一规范化后的核验工具 schema SHA256（与 prepare 共用）。"""

    return canonical_json_sha256(_schema())


def check_schema_integrity(plan: dict[str, Any]) -> str:
    """重算 schema 的规范化 SHA256，与冻结计划核对；不一致即拒绝运行。"""

    observed = compute_schema_sha256()
    recorded = plan["sources"]["schema_sha256"]
    if observed != recorded:
        raise PlanError(
            "核验工具 schema 的规范化 SHA256 与冻结计划不一致："
            f"{observed} != {recorded}"
        )
    return observed


# ---------------------------------------------------------------------------
# 窗口输入与请求构造
# ---------------------------------------------------------------------------


def check_window_inputs(plan: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """核对两个窗口的冻结输入哈希；只哈希，不落正文。"""

    observed: dict[str, dict[str, Any]] = {}
    for window in plan["windows"]:
        path = Path(window["input_path"]).expanduser()
        if not path.is_file():
            raise PlanError(f"窗口 {window['window_id']} 的冻结输入不存在：{path}")
        digest = _sha256_bytes(path.read_bytes())
        if digest != window["input_sha256"]:
            raise PlanError(
                f"窗口 {window['window_id']} 的输入 SHA 与冻结计划不一致：{digest}"
            )
        observed[window["window_id"]] = {
            "input_path": str(path),
            "input_sha256": digest,
            "input_bytes": path.stat().st_size,
        }
    return observed


def build_requests(
    plan: dict[str, Any], prompts: dict[str, str]
) -> list[dict[str, Any]]:
    """按冻结顺序表构造 16 个位置的请求摘要（不含正文）。"""

    windows = {window["window_id"]: window for window in plan["windows"]}
    requests: list[dict[str, Any]] = []
    for entry in plan["schedule"]["invocations"]:
        window = windows[entry["window_id"]]
        source = json.loads(
            Path(window["input_path"]).expanduser().read_text(encoding="utf-8")
        )
        messages = source.get("public_invoke_messages")
        if not isinstance(messages, list) or len(messages) != 2:
            raise PlanError(f"窗口 {entry['window_id']} 的冻结输入结构异常。")
        user_message = messages[1]["content"]
        if not isinstance(user_message, str) or not user_message.strip():
            raise PlanError(f"窗口 {entry['window_id']} 的 user 消息为空。")
        requests.append({
            "sequence": entry["sequence"],
            "slot_id": entry["slot_id"],
            "exec_order": entry["exec_order"],
            "phase": entry["phase"],
            "window_id": entry["window_id"],
            "repeat": entry["repeat"],
            "arm": entry["arm"],
            "arm_index_in_slot": entry["arm_index_in_slot"],
            "input_sha256": window["input_sha256"],
            "prompt_body_sha256": _sha256_text(prompts[entry["arm"]]),
            "user_message_sha256": _sha256_text(user_message),
            "user_message_chars": len(user_message),
            "user_message": user_message,
        })
    return requests


# ---------------------------------------------------------------------------
# 位置记录与门槛判定
# ---------------------------------------------------------------------------


def blank_record(
    *,
    phase: int,
    arm: str,
    sequence: int = 0,
    slot_id: str = "",
    exec_order: int = 0,
    window_id: str = "",
    repeat: str = "",
) -> dict[str, Any]:
    """构造一条“未运行”的位置记录；失败与空返回照此计入分母。"""

    return {
        "sequence": sequence,
        "slot_id": slot_id,
        "exec_order": exec_order,
        "phase": phase,
        "window_id": window_id,
        "repeat": repeat,
        "arm": arm,
        "arm_index_in_slot": 0,
        "invoked": False,
        "structural_valid": False,
        "failure": None,
        "empty_return": False,
        "protocol_failure": False,
        "not_run": True,
        "verdict": None,
        "issues": [],
        "evidence_count": 0,
        "tool_calls": 0,
        "latency_ms": None,
        "usage": None,
        "hard_reject": False,
        "bad_auto": False,
        "stays_pending": None,
        "field_fidelity": None,
    }


def _validated_verdict(payload: object) -> tuple[str | None, list[str], int]:
    """从结构化返回里取出 verdict／issues 与证据条数；结构非法即返回空 verdict。"""

    if not isinstance(payload, dict) or set(payload) != {"results"}:
        return None, [], 0
    results = payload["results"]
    if not isinstance(results, list) or len(results) != 1:
        return None, [], 0
    item = results[0]
    if not isinstance(item, dict):
        return None, [], 0
    verdict = item.get("verdict")
    issues = item.get("issues")
    evidence = item.get("evidence")
    if verdict not in SEMANTIC_VERDICTS:
        return None, [], 0
    if not isinstance(issues, list) or any(
        not isinstance(issue, str) for issue in issues
    ):
        return None, [], 0
    if not isinstance(evidence, list):
        return None, [], 0
    return verdict, list(issues), len(evidence)


def build_evaluation_record(
    *,
    invocation: dict[str, Any],
    response: object | None = None,
    error: BaseException | None = None,
    latency_ms: int | None = None,
    checked_at: str | None = None,
) -> dict[str, Any]:
    """把一次 invocation 的原始返回或错误折叠成位置记录。"""

    record = blank_record(
        phase=invocation["phase"], arm=invocation["arm"],
        sequence=invocation["sequence"], slot_id=invocation["slot_id"],
        exec_order=invocation["exec_order"], window_id=invocation["window_id"],
        repeat=invocation["repeat"],
    )
    record["arm_index_in_slot"] = invocation.get("arm_index_in_slot", 0)
    record["input_sha256"] = invocation.get("input_sha256")
    record["prompt_body_sha256"] = invocation.get("prompt_body_sha256")
    record["latency_ms"] = latency_ms
    record["checked_at"] = checked_at or _timestamp()
    record["invoked"] = error is None

    if error is not None:
        record["failure"] = type(error).__name__
        record["protocol_failure"] = True
        record["not_run"] = False
        return record

    calls = getattr(response, "tool_calls", None) or []
    record["tool_calls"] = len(calls)
    if not calls:
        record["empty_return"] = True
        record["not_run"] = False
        return record
    payload = calls[0].get("args") if isinstance(calls[0], dict) else None
    verdict, issues, evidence_count = _validated_verdict(payload)
    record["not_run"] = False
    if verdict is None:
        record["failure"] = "InvalidStructuredOutput"
        record["protocol_failure"] = True
        return record
    record["structural_valid"] = True
    record["verdict"] = verdict
    record["issues"] = issues
    record["evidence_count"] = evidence_count
    # 判败哨兵（冻结定义）：本轮 16 个位置都是“已知完整合法正例 + 原 14 字段正确”，
    # 预期形态是 supported 且 issues=[]。因此
    #   - bad_auto = 给出完整通过（supported）但 issues 非空：在已知正例上同时
    #     确认主张又标记问题，正文／字段必有一处确定错误，属于“坏 auto”哨兵；
    #   - hard_reject = verdict 为 unsupported：完整合法正例被判硬拒。
    # 正文与字段保真由两臂逐字相同的输入保证（V 不改正文），所以这里只做哨兵；
    # 真实去向仍由产品采纳门决定，本记录不声称线上 auto 采纳数。
    record["bad_auto"] = verdict == "supported" and bool(issues)
    record["hard_reject"] = verdict == "unsupported"
    record["stays_pending"] = True
    record["field_fidelity"] = True
    return record


def normalize_records(
    records: list[dict[str, Any]], *, plan: dict[str, Any], phase: int
) -> list[dict[str, Any]]:
    """按冻结顺序补齐缺失位置为“未运行”；不重跑、不补位。

    位置身份用调用序号（1..16）；同一个位置出现两次即视为计划被破坏。
    """

    expected = [
        entry for entry in plan["schedule"]["invocations"]
        if entry["phase"] == phase
    ]
    by_sequence: dict[int, dict[str, Any]] = {}
    for record in records:
        sequence = record.get("sequence")
        if not isinstance(sequence, int):
            raise PlanError("位置记录缺少整数调用序号。")
        if sequence in by_sequence:
            raise PlanError(f"位置 {sequence} 被记录了两次，计划被破坏。")
        by_sequence[sequence] = record
    normalized: list[dict[str, Any]] = []
    for entry in expected:
        found = by_sequence.get(entry["sequence"])
        if found is None:
            record = blank_record(
                phase=phase, arm=entry["arm"], sequence=entry["sequence"],
                slot_id=entry["slot_id"], exec_order=entry["exec_order"],
                window_id=entry["window_id"], repeat=entry["repeat"],
            )
            record["arm_index_in_slot"] = entry["arm_index_in_slot"]
        else:
            record = found
            if (
                record.get("slot_id") != entry["slot_id"]
                or record.get("arm") != entry["arm"]
            ):
                raise PlanError(f"位置 {entry['sequence']} 的槽位或臂不符。")
        normalized.append(record)
    return normalized


def _counts(records: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "positions": len(records),
        "baseline": sum(1 for record in records if record["arm"] == "baseline"),
        "candidate": sum(1 for record in records if record["arm"] == "candidate"),
    }


def _denominator(records: list[dict[str, Any]]) -> dict[str, int]:
    return {
        arm: sum(1 for record in records if record["arm"] == arm) for arm in ARMS
    }


def _downgrades(records: list[dict[str, Any]]) -> dict[str, int]:
    """不必要降级：uncertain／unsupported，或 supported 但 issues 非空。"""

    counts = {arm: 0 for arm in ARMS}
    for record in records:
        verdict = record.get("verdict")
        issues = record.get("issues") or []
        downgraded = (
            verdict in DOWNGRADE_VERDICTS
            or (verdict == "supported" and bool(issues))
        )
        if downgraded and record["arm"] in counts:
            counts[record["arm"]] += 1
    return counts


def _flag_counts(records: list[dict[str, Any]], flag: str) -> dict[str, int]:
    return {
        arm: sum(
            1 for record in records
            if record["arm"] == arm and bool(record.get(flag))
        )
        for arm in ARMS
    }


def _total(records: list[dict[str, Any]], flag: str) -> int:
    return sum(1 for record in records if bool(record.get(flag)))


def evaluate_phase1_gates(
    plan: dict[str, Any], records: list[dict[str, Any]]
) -> dict[str, Any]:
    """阶段 1 的 G1-a 完整性、G1-b 安全、G1-c 方向。"""

    normalized = normalize_records(records, plan=plan, phase=1)
    threshold = plan["gates"]["phase1"]["checks"]
    structural = sum(1 for record in normalized if record["structural_valid"])
    empty_returns = _total(normalized, "empty_return")
    protocol_failures = _total(normalized, "protocol_failure")
    not_run = _total(normalized, "not_run")
    downgrades = _downgrades(normalized)
    bad_auto = _flag_counts(normalized, "bad_auto")
    hard_rejects = _flag_counts(normalized, "hard_reject")

    g1a = {
        "name": "G1-a 完整性",
        "required": threshold["G1-a"]["requirement"],
        "structurally_valid": structural,
        "expected_structurally_valid": threshold["G1-a"]["threshold"][
            "structurally_valid"
        ],
        "empty_returns": empty_returns,
        "protocol_failures": protocol_failures,
        "not_run": not_run,
        "passed": (
            structural == threshold["G1-a"]["threshold"]["structurally_valid"]
            and empty_returns == threshold["G1-a"]["threshold"]["empty_returns"]
            and protocol_failures == threshold["G1-a"]["threshold"]["protocol_failures"]
            and not_run == threshold["G1-a"]["threshold"]["not_run"]
        ),
    }
    g1b = {
        "name": "G1-b 安全",
        "required": threshold["G1-b"]["requirement"],
        "bad_auto": bad_auto,
        "hard_rejects": hard_rejects,
        "passed": (
            sum(bad_auto.values()) == threshold["G1-b"]["threshold"]["bad_auto"]
            and sum(hard_rejects.values())
            == threshold["G1-b"]["threshold"]["hard_reject"]
        ),
    }
    candidate_max = threshold["G1-c"]["threshold"]["candidate_max"]
    g1c = {
        "name": "G1-c 方向",
        "required": threshold["G1-c"]["requirement"],
        "downgrades": downgrades,
        "candidate_max": candidate_max,
        "candidate_max_kind": "拟议值",
        "passed": (
            downgrades["candidate"] <= downgrades["baseline"]
            and downgrades["candidate"] <= candidate_max
        ),
    }
    failed = [name for name, gate in (
        ("G1-a", g1a), ("G1-b", g1b), ("G1-c", g1c),
    ) if not gate["passed"]]
    return {
        "phase": 1,
        "passed": not failed,
        "failed_gates": failed,
        "checks": {"G1-a": g1a, "G1-b": g1b, "G1-c": g1c},
        "downgrades": downgrades,
        "bad_auto": bad_auto,
        "hard_rejects": hard_rejects,
        "denominator": _denominator(normalized),
        "positions": _counts(normalized),
    }


def evaluate_phase2_gates(
    plan: dict[str, Any], records: list[dict[str, Any]]
) -> dict[str, Any]:
    """阶段 2 的安全门、运行门与主判定三分支。

    阶段 2 是**合并判定**：安全门与运行门按 16 个位置（阶段 1 + 阶段 2）评估，
    主判定比较两臂各 8 个位置的降级计数。
    """

    normalized = (
        normalize_records(records, plan=plan, phase=1)
        + normalize_records(records, plan=plan, phase=2)
    )
    thresholds = plan["gates"]["phase2"]
    safety_threshold = thresholds["safety_gate"]["threshold"]
    runtime_threshold = thresholds["runtime_gate"]["threshold"]

    bad_auto = _flag_counts(normalized, "bad_auto")
    hard_rejects = _flag_counts(normalized, "hard_reject")
    pending_positions = sum(
        1 for record in normalized if record.get("stays_pending") is True
    )
    safety_gate = {
        "name": "安全门",
        "required": thresholds["safety_gate"]["requirement"],
        "bad_auto": bad_auto,
        "hard_rejects": hard_rejects,
        "pending_positions": pending_positions,
        "pending_expected": safety_threshold["pending"],
        "passed": (
            sum(bad_auto.values()) == safety_threshold["bad_auto"]
            and sum(hard_rejects.values()) == safety_threshold["hard_reject"]
            and pending_positions == safety_threshold["pending"]
        ),
    }

    structural = sum(1 for record in normalized if record["structural_valid"])
    failures_or_empty = {
        arm: sum(
            1 for record in normalized
            if record["arm"] == arm
            and (record["failure"] is not None or record["empty_return"]
                 or record["not_run"])
        )
        for arm in ARMS
    }
    per_arm_max = runtime_threshold["per_arm_failures_or_empty_max"]
    runtime_passed = (
        structural == runtime_threshold["structurally_valid"]
        and all(count <= per_arm_max for count in failures_or_empty.values())
    )
    runtime_gate = {
        "name": "运行门",
        "required": thresholds["runtime_gate"]["requirement"],
        "structurally_valid": structural,
        "expected_structurally_valid": runtime_threshold["structurally_valid"],
        "failures_or_empty": failures_or_empty,
        "per_arm_failures_or_empty_max": per_arm_max,
        "per_arm_failures_or_empty_max_kind": "拟议值",
        "passed": runtime_passed,
        "status": "通过" if runtime_passed else "证据不足",
    }

    downgrades = _downgrades(normalized)
    candidate = downgrades["candidate"]
    baseline = downgrades["baseline"]
    if candidate == baseline == 0:
        branch, statement = (
            "no_observable_signal",
            "本轮没有可观测的对照信号；不得当作收益通过，也不自动追加预算。",
        )
    elif candidate < baseline:
        branch, statement = (
            "benefit", "候选降级位置数 < 基线：有收益。",
        )
    elif candidate == baseline:
        branch, statement = (
            "no_difference", "候选降级位置数 = 基线：无差异。",
        )
    else:
        branch, statement = (
            "harmful", "候选降级位置数 > 基线：有害。",
        )
    main_judgment = {
        "name": "主判定",
        "required": thresholds["main_judgment"]["requirement"],
        "downgrades": downgrades,
        "branch": branch,
        "statement": statement,
    }

    passed = safety_gate["passed"] and runtime_gate["passed"]
    return {
        "phase": 2,
        "passed": passed,
        "safety_gate": safety_gate,
        "runtime_gate": runtime_gate,
        "main_judgment": main_judgment,
        "downgrades": downgrades,
        "bad_auto": bad_auto,
        "hard_rejects": hard_rejects,
        "pending_positions": pending_positions,
        "denominator": _denominator(normalized),
        "positions": _counts(normalized),
        "next": {
            "benefit": "记录“单叶在这 2 个匿名窗口上稳定降低不必要降级”；产品默认保持现状，不外推真实聊天。",
            "no_difference": "记录“未观察到收益，也未观察到危害”；不回滚、不宣称提升，按“验证完成、收益未证明”结项。",
            "harmful": "结论建议回滚；另开实现票，取得用户批准后才改提示，本轮不改产品默认。",
            "no_observable_signal": "记为“本轮没有可观测的对照信号”；不追加预算，是否继续由用户另行决定，默认不加。",
            "gate_failed": "判败闭账；若安全门失败，另开票评估单叶去留；不补跑、不调参、不加臂。",
        }["gate_failed" if not passed else branch],
    }


def phase1_defeat_outcome(
    plan: dict[str, Any], records: list[dict[str, Any]]
) -> dict[str, Any]:
    """阶段 1 判定结果；判败即永久关闭阶段 2 的 8 次调用。"""

    gate = evaluate_phase1_gates(plan, records)
    failed = not gate["passed"]
    return {
        "kind": "memory-claim-retention-repetition-phase1-outcome-v2",
        "phase1_gates": gate,
        "phase1_failed": failed,
        "failed_gates": gate["failed_gates"],
        "phase2_status": "permanently-closed" if failed else "open",
        "invokes_used": 8,
        "invokes_closed_unused": 8 if failed else 0,
        "budget_closed": failed,
        "no_retry_or_rerun": True,
    }


# ---------------------------------------------------------------------------
# 预算
# ---------------------------------------------------------------------------


def budget_summary(plan: dict[str, Any], attempted_invokes: int = 0) -> dict[str, Any]:
    """预算上限 16 与 E／V／R 拆分。

    `remaining` 是理论上限减已尝试次数，用于越界断言；runner 不按它跳过任何位置，
    失败与空返回照占名额。
    """

    budget = plan["budget"]
    maximum = budget["max_public_invokes"]
    planned = len(plan["schedule"]["invocations"])
    return {
        "max_public_invokes": maximum,
        "E": budget["E"],
        "V": budget["V"],
        "R": budget["R"],
        "planned_public_invokes": planned,
        "attempted_public_invokes": attempted_invokes,
        "remaining": maximum - attempted_invokes,
        "phase1_invokes": budget["phase1_invokes"],
        "phase2_invokes": budget["phase2_invokes"],
        "no_retry_no_backfill_no_extra_arm": budget["no_retry_no_backfill_no_extra_arm"],
    }


def assert_within_budget(plan: dict[str, Any], *, attempted_invokes: int) -> None:
    if attempted_invokes > plan["budget"]["max_public_invokes"]:
        raise PlanError(
            "拟调用次数超出冻结预算 16："
            f"{attempted_invokes} > {plan['budget']['max_public_invokes']}"
        )


# ---------------------------------------------------------------------------
# 私有目录与写入（目录 0700、文件 0600）
# ---------------------------------------------------------------------------


def _prepare_private_dir(output_root: Path) -> None:
    output_root.mkdir(parents=True, exist_ok=True)
    try:
        output_root.chmod(PRIVATE_DIR_MODE)
    except OSError:
        pass


def _write_json(path: Path, payload: object) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
    )
    try:
        path.chmod(PRIVATE_FILE_MODE)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# 请求构造与调用
# ---------------------------------------------------------------------------


def _arm_payload(prompt: str, user_message: object) -> list[dict[str, object]]:
    return [
        {"role": "system", "content": prompt},
        {"role": "user", "content": user_message},
    ]


def _schema() -> dict[str, Any]:
    sys.path.insert(0, str(REPO / "src"))
    from notalone.memory_extraction.verification_adapters import (
        SOURCE_VERIFICATION_SCHEMA,
    )

    return SOURCE_VERIFICATION_SCHEMA


def _tool_choice_supported_ast() -> bool:
    """静态确认 `_invoke` 使用具名 `tool_choice`（钉扎结构化工具）。"""

    tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
    invoke = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_invoke"
    )
    return any(
        isinstance(node, ast.keyword) and node.arg == "tool_choice"
        for node in ast.walk(invoke)
    )


def _invoke(model: Any, schema: dict[str, Any], prompt: str, messages: object) -> Any:
    """优先钉扎结构化工具；端点不支持时退回普通工具选择并留证。"""

    payload = _arm_payload(prompt, messages)
    try:
        bound = model.bind_tools([schema], tool_choice=schema["title"])
        return bound.invoke(payload)
    except Exception as error:  # noqa: BLE001 - 端点能力差异要留证据
        print(f"  钉扎工具失败（{type(error).__name__}），退回默认工具选择")
        return model.bind_tools([schema]).invoke(payload)


# ---------------------------------------------------------------------------
# 凭据与模型（只允许出现在真实运行路径，且晚于 dry-run 返回）
# ---------------------------------------------------------------------------


def _api_key_fingerprint(key: str) -> str:
    return _sha256_text(key)[:16]


def _load_runtime_model(plan: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    """读取凭据并构造 ECNU 客户端。只在真实运行路径调用。"""

    from notalone.runtime_config import load_project_env

    load_project_env()
    key = os.environ.get(API_KEY_ENV_VAR, "").strip()
    if not key:
        raise PlanError(
            f"缺少 {API_KEY_ENV_VAR}：请在 .env 或环境变量提供可用 ECNU key。"
        )
    base_url = (
        os.environ.get(BASE_URL_ENV_VAR, "").strip() or DEFAULT_BASE_URL
    )
    host = _url_host(base_url)
    if host in OFFICIAL_ENDPOINT_HOSTS:
        raise PlanError(f"拒绝使用官方端点：{host}")
    if host != ECNU_ENDPOINT_HOST:
        raise PlanError(f"只允许既有 ECNU 端点 {ECNU_ENDPOINT_HOST}，当前为 {host}")

    from notalone.reply.adapters.deepseek_provider import build_deepseek_model

    model = build_deepseek_model(
        model_name=plan["scope"]["model"],
        base_url=base_url,
        extra_body={"thinking": {"type": "enabled"}},
    )
    return model, {
        "endpoint_host": host,
        "base_url": base_url,
        "key_fingerprint_sha256": _api_key_fingerprint(key),
        "fallback_provider": "none",
        "official_endpoint_or_key": False,
    }


def _url_host(base_url: str) -> str:
    remainder = base_url.split("://", 1)[-1]
    return remainder.split("/", 1)[0].split("@")[-1].split(":")[0].lower()


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _position_rows(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "sequence": request["sequence"],
            "exec_order": request["exec_order"],
            "phase": request["phase"],
            "window_id": request["window_id"],
            "repeat": request["repeat"],
            "arm": request["arm"],
            "arm_index_in_slot": request["arm_index_in_slot"],
            "invoke": 1,
            "input_sha256": request["input_sha256"],
            "prompt_body_sha256": request["prompt_body_sha256"],
            "user_message_sha256": request["user_message_sha256"],
        }
        for request in requests
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="票 01 重复测量对照（2 窗口 × 4 重复 × 2 臂）",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="走完除真实调用外的全流程：不读凭据、不联网",
    )
    args = parser.parse_args(argv)

    plan = load_plan()
    source_integrity = check_source_integrity(plan)
    schema_integrity = check_schema_integrity(plan)
    prompts = arm_prompts(plan)
    prompt_integrity = check_prompt_integrity(plan)
    window_integrity = check_window_inputs(plan)
    requests = build_requests(plan, prompts)
    budget = budget_summary(plan)
    assert_within_budget(plan, attempted_invokes=len(requests))
    _prepare_private_dir(args.output)
    _write_json(args.output / "position-criteria-v2.json", {
        "kind": "memory-claim-retention-repetition-position-criteria-v2",
        "frozen_before_run": True,
        "written_at": _timestamp(),
        "criteria": plan["position_criteria"],
        "note": "本文件在唯一一次真实运行前写入；dry-run 也先写本文件。",
    })

    if args.dry_run:
        record = {
            "kind": "memory-claim-retention-repetition-dry-run-v2",
            "dry_run": True,
            "checked_at": _timestamp(),
            "plan_path": str(PLAN_PATH),
            "plan_sha256": _sha256_bytes(PLAN_PATH.read_bytes()),
            "plan_status": plan["status"],
            "mode": "dry-run-before-credential-read",
            "credentials_read": None,
            "network_calls": 0,
            "invokes_planned": len(requests),
            "invokes_executed": 0,
            "budget": budget,
            "budget_ok": len(requests) == plan["budget"]["max_public_invokes"],
            "source_integrity": source_integrity,
            "schema_integrity": schema_integrity,
            "prompt_integrity": prompt_integrity,
            "window_integrity": window_integrity,
            "order_table": [
                {
                    "exec_order": slot["exec_order"],
                    "phase": slot["phase"],
                    "window_id": slot["window_id"],
                    "repeat": slot["repeat"],
                    "arm_order": slot["arm_order"],
                    "arms": slot["arms"],
                }
                for slot in plan["schedule"]["slots"]
            ],
            "schedule_balance": plan["schedule"]["balance"],
            "positions": _position_rows(requests),
            "gates": {
                "phase1": {
                    "invokes": plan["gates"]["phase1"]["invokes"],
                    "checks": list(plan["gates"]["phase1"]["checks"]),
                },
                "phase2": {
                    "invokes": plan["gates"]["phase2"]["invokes"],
                    "safety_gate": plan["gates"]["phase2"]["safety_gate"][
                        "requirement"
                    ],
                    "runtime_gate": plan["gates"]["phase2"]["runtime_gate"][
                        "requirement"
                    ],
                    "main_judgment": plan["gates"]["phase2"]["main_judgment"][
                        "requirement"
                    ],
                },
            },
            "private_output_dir": str(args.output),
            "business_writes": 0,
            "reads_real_chat_or_holdout": False,
            "official_endpoint_or_key": False,
        }
        _write_json(args.output / "dry-run-v2.json", record)
        _print_dry_run(record)
        return 0

    # ---- 以下是真实运行路径：只有走到这里才读取凭据。 ----
    model, credential_info = _load_runtime_model(plan)
    schema = _schema()
    schema_sha256 = canonical_json_sha256(schema)
    preflight = {
        "kind": "memory-claim-retention-repetition-preflight-v2",
        "planned_at": _timestamp(),
        "plan_sha256": _sha256_bytes(PLAN_PATH.read_bytes()),
        "model": plan["scope"]["model"],
        "thinking": plan["scope"]["thinking"],
        "endpoint_host": credential_info["endpoint_host"],
        "base_url": credential_info["base_url"],
        "key_fingerprint_sha256": credential_info["key_fingerprint_sha256"],
        "fallback_provider": credential_info["fallback_provider"],
        "official_endpoint_or_key": credential_info["official_endpoint_or_key"],
        "schema_sha256": schema_sha256,
        "schema_sha256_recorded": plan["sources"]["schema_sha256"],
        "schema_sha256_matches_recorded": (
            schema_sha256 == plan["sources"]["schema_sha256"]
        ),
        "source_integrity": source_integrity,
        "prompt_integrity": prompt_integrity,
        "window_integrity": window_integrity,
        "positions": _position_rows(requests),
        "budget": budget,
        "tool_choice_pinned": _tool_choice_supported_ast(),
    }
    _write_json(args.output / "preflight-v2.json", preflight)

    reservation = {
        "kind": "memory-claim-retention-repetition-budget-reservation-v2",
        "reserved_at": _timestamp(),
        "max_public_invokes": plan["budget"]["max_public_invokes"],
        "E": plan["budget"]["E"],
        "V": plan["budget"]["V"],
        "R": plan["budget"]["R"],
        "phase1_invokes": plan["budget"]["phase1_invokes"],
        "phase2_invokes": plan["budget"]["phase2_invokes"],
        "planned_positions": len(requests),
        "no_retry_no_backfill_no_extra_arm": True,
        "phase2_closes_permanently_if_phase1_fails": True,
        "failure_and_empty_still_count": True,
        "note": "每个计划位置占一个名额；失败与空返回照计分母，不重跑、不补位。",
    }
    _write_json(args.output / "budget-reservation-v2.json", reservation)
    print(
        f"预算已预约：{len(requests)} 次公开调用"
        f"（E={plan['budget']['E']}／V={plan['budget']['V']}／R={plan['budget']['R']}）；"
        "失败与空返回照计分母，不重跑。"
    )

    evaluations: list[dict[str, Any]] = []
    prompts_by_arm = prompts
    announced_phase2 = False
    for request in requests:
        if request["phase"] == 2 and not announced_phase2:
            announced_phase2 = True
            print("阶段 1 已通过，进入阶段 2。")
        print(
            f"[{request['sequence']:02d}/16] {request['slot_id']} "
            f"{request['window_id']} {request['repeat']} "
            f"{request['arm']}（阶段 {request['phase']}）"
        )
        started = datetime.now(timezone.utc)
        latency_ms: int | None = None
        response: object | None = None
        error: BaseException | None = None
        measured = _perf_counter()
        try:
            response = _invoke(
                model, schema, prompts_by_arm[request["arm"]],
                request["user_message"],
            )
        except BaseException as caught:  # noqa: BLE001 - 失败位置要留证据
            error = caught
        latency_ms = int((_perf_counter() - measured) * 1000)
        record = build_evaluation_record(
            invocation=request, response=response, error=error,
            latency_ms=latency_ms, checked_at=started.isoformat(),
        )
        record["usage"] = getattr(response, "usage_metadata", None)
        evaluations.append(record)
        _write_json(
            args.output / f"p{request['sequence']:02d}-{request['arm']}-V-response.json",
            {
                "kind": "memory-claim-retention-repetition-raw-v2",
                "sequence": request["sequence"],
                "slot_id": request["slot_id"],
                "window_id": request["window_id"],
                "repeat": request["repeat"],
                "arm": request["arm"],
                "input_sha256": request["input_sha256"],
                "prompt_body_sha256": request["prompt_body_sha256"],
                "user_message_sha256": request["user_message_sha256"],
                "error": None if error is None else {
                    "type": type(error).__name__, "message": str(error),
                },
                "raw_response": _raw_response(response),
                "usage": record["usage"],
            },
        )
        _write_json(
            args.output / f"p{request['sequence']:02d}-{request['arm']}-audit.json",
            record,
        )
        print(
            "  "
            + (
                f"失败={record['failure']}"
                if record["failure"] else
                f"空返回（0 tool_calls）" if record["empty_return"] else
                f"verdict={record['verdict']} issues={record['issues']}"
            )
        )

        if request["sequence"] == plan["budget"]["phase1_invokes"]:
            phase1 = evaluate_phase1_gates(plan, evaluations)
            _write_json(args.output / "phase1-gates-v2.json", phase1)
            if not phase1["passed"]:
                outcome = phase1_defeat_outcome(plan, evaluations)
                outcome["closed_at"] = _timestamp()
                outcome["invokes_used"] = len(evaluations)
                outcome["positions"] = [
                    {
                        "sequence": record["sequence"],
                        "arm": record["arm"],
                        "verdict": record["verdict"],
                        "issues": record["issues"],
                        "structural_valid": record["structural_valid"],
                    }
                    for record in evaluations
                ]
                _write_json(args.output / "close-v2.json", outcome)
                print(
                    "阶段 1 判败"
                    f"（{'、'.join(outcome['failed_gates'])}）："
                    "阶段 2 的 8 次调用永久关闭，不补跑、不调参、不加臂。"
                )
                return 2

    phase2 = evaluate_phase2_gates(plan, evaluations)
    _write_json(args.output / "phase2-gates-v2.json", phase2)
    summary = {
        "kind": "memory-claim-retention-repetition-summary-v2",
        "finished_at": _timestamp(),
        "plan_sha256": _sha256_bytes(PLAN_PATH.read_bytes()),
        "invokes_used": len(evaluations),
        "budget": budget,
        "phase1": evaluate_phase1_gates(plan, evaluations),
        "phase2": phase2,
        "credentials_read": True,
        "key_fingerprint_sha256": credential_info["key_fingerprint_sha256"],
        "endpoint_host": credential_info["endpoint_host"],
        "business_writes": 0,
        "reads_real_chat_or_holdout": False,
        "retries": 0,
        "backfills": 0,
    }
    _write_json(args.output / "summary-v2.json", summary)
    close = {
        "kind": "memory-claim-retention-repetition-close-v2",
        "closed_at": _timestamp(),
        "invokes_used": len(evaluations),
        "max_public_invokes": plan["budget"]["max_public_invokes"],
        "budget_closed": True,
        "no_retry_or_rerun": True,
        "retries": 0,
        "backfills": 0,
        "endpoint_host": credential_info["endpoint_host"],
        "official_endpoint_or_key": False,
        "business_writes": 0,
        "safety_gate_passed": phase2["safety_gate"]["passed"],
        "runtime_gate_passed": phase2["runtime_gate"]["passed"],
        "main_judgment": phase2["main_judgment"]["branch"],
        "downgrades": phase2["downgrades"],
        "next": phase2["next"],
    }
    _write_json(args.output / "close-v2.json", close)
    print(
        f"完成 {len(evaluations)} 次调用；安全门={phase2['safety_gate']['passed']}、"
        f"运行门={phase2['runtime_gate']['passed']}、"
        f"主判定={phase2['main_judgment']['branch']}；原始返回在 {args.output}"
    )
    return 0


def _raw_response(response: object | None) -> object:
    if response is None:
        return None
    return {
        "tool_calls": getattr(response, "tool_calls", None),
        "response_metadata": getattr(response, "response_metadata", None),
        "content": getattr(response, "content", None),
    }


def _perf_counter() -> float:
    import time

    return time.perf_counter()


def _print_dry_run(record: dict[str, Any]) -> None:
    print("DRY-RUN（未读凭据、未联网、未调用模型）")
    print(f"  冻结计划：{record['plan_path']}")
    print(
        "  两臂提示正文 SHA256："
        f"baseline={record['prompt_integrity']['baseline']['prompt_body_sha256'][:16]}"
        "（git e015b96）、"
        f"candidate={record['prompt_integrity']['candidate']['prompt_body_sha256'][:16]}"
    )
    print(
        "  候选提示文件 SHA256："
        f"{record['prompt_integrity']['candidate']['prompt_file_sha256']}"
    )
    print(
        "  运行源码 SHA256："
        f"runner={record['source_integrity']['runner_script_sha256'][:16]}、"
        f"prepare={record['source_integrity']['prepare_script_sha256'][:16]}"
    )
    print(f"  核验 schema 规范化 SHA256：{record['schema_integrity']}")
    for window_id, integrity in record["window_integrity"].items():
        print(
            f"  {window_id} 输入：{integrity['input_path']}"
            f"（SHA256 {integrity['input_sha256']}）"
        )
    print(
        f"  预算：{record['budget']['max_public_invokes']} 次"
        f"（E={record['budget']['E']}／V={record['budget']['V']}／"
        f"R={record['budget']['R']}）；计划位置 {record['invokes_planned']} 个"
    )
    print("  16 个位置与执行顺序：")
    for position in record["positions"]:
        print(
            f"    {position['sequence']:02d}. 执行序 {position['exec_order']} "
            f"阶段 {position['phase']} {position['window_id']} {position['repeat']} "
            f"→ {position['arm']}（臂内第 {position['arm_index_in_slot']} 次）"
        )
    print("  分阶段门：")
    print(
        "    阶段 1："
        + "、".join(record["gates"]["phase1"]["checks"])
        + f"（{record['gates']['phase1']['invokes']} 次）"
    )
    print(
        "    阶段 2：安全门／运行门／主判定"
        f"（{record['gates']['phase2']['invokes']} 次）"
    )
    print(f"  dry-run 记录：{record['private_output_dir']}/dry-run-v2.json")


if __name__ == "__main__":
    raise SystemExit(main())

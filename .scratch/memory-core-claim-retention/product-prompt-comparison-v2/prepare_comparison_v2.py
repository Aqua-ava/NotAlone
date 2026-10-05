"""冻结票 01「记忆核心事实保留」的重复测量对照计划（不调用模型、不读凭据）。

本脚本只做冻结：读取提案（`docs/memory-claim-retention-repetition-pilot-proposal-20261005.md`）
第 2.2／2.4／3 节的顺序表、门槛与预算，重算两臂提示与两个匿名窗口的 SHA256，
再写出 `frozen-plan-v2.json`。

边界：0 次真实模型调用、0 次凭据读取、0 次联网；只读仓库内文件、
git 历史提交 `e015b96` 的源码，以及仓库外私有目录里两个已冻结匿名窗口的
公开输入（只算哈希，不落正文）。不读真实聊天、不读 actual／held 留出。

用法：
    conda run -n NotAlone python .scratch/memory-core-claim-retention/\
product-prompt-comparison-v2/prepare_comparison_v2.py
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import ModuleType
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PLAN_PATH = HERE / "frozen-plan-v2.json"
PROPOSAL_PATH = REPO / "docs" / "memory-claim-retention-repetition-pilot-proposal-20261005.md"
V1_PLAN_PATH = HERE.parent / "product-prompt-comparison-v1" / "frozen-plan-v1.json"

# ---------------------------------------------------------------------------
# 提案常量（第 2.1、2.2、2.4、3 节）。全部在冻结时重新核对；不一致即拒绝冻结。
# ---------------------------------------------------------------------------

PROPOSAL_SECTION_2_2 = "第 2.2 节表（8 个「窗口 × 重复」位置）"
BASELINE_PROMPT_COMMIT = "e015b96"
BASELINE_PROMPT_SOURCE = "src/notalone/memory_extraction/verification_adapters.py"
CANDIDATE_PROMPT_SOURCE = "src/notalone/memory_extraction/verification_adapters.py"

# 提案第 2.2 节表格逐行的执行序／臂序。
SLOT_ORDER_TABLE: tuple[tuple[int, int, str, str, int], ...] = (
    (1, 1, "W1", "baseline-first", 2),
    (2, 1, "W2", "candidate-first", 2),
    (3, 2, "W1", "candidate-first", 2),
    (4, 2, "W2", "baseline-first", 2),
    (5, 3, "W1", "baseline-first", 2),
    (6, 3, "W2", "candidate-first", 2),
    (7, 4, "W1", "candidate-first", 2),
    (8, 4, "W2", "baseline-first", 2),
)

# 提案第 2.1 节表格的窗口顺序与输入哈希。
EXPECTED_WINDOW_SHA256: tuple[str, ...] = (
    "6f873ef4ac1f6c8952a034c0ca98c5ccd25454b13dd445f07d72577c608dbcc5",
    "0b1549bd53b73ef4c033b46357d76f75f5d74eca7d7bd174a467b2e90c56d512",
)

# 上一轮（v1）冻结时记录的提示正文 SHA；本轮必须一致，否则基线已经漂移。
EXPECTED_BASELINE_PROMPT_SHA256 = (
    "f5eb0461b9e19cf7c3f1b6e1627eaf281b487e9c29a2a59588d8301e2717687e"
)
EXPECTED_CANDIDATE_PROMPT_SHA256 = (
    "620ef476b448318cfda4cac14551d9b55804f3605c8e31ab002e17dd5a36c7ea"
)

# 提案第 2.2 节：单叶是候选相对基线的唯一差别，规模为 6 行新增。
EXPECTED_SINGLE_LEAF_ADDED_LINES = 6


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return _sha256_bytes(text.encode("utf-8"))


def _sha256_file(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _load_runner_module() -> ModuleType:
    """加载同目录的 runner，复用它的规范化 schema 哈希与路径解析。

    只复用纯函数：runner 的模块级代码不读凭据、不联网、不加载冻结计划。
    """

    spec = importlib.util.spec_from_file_location(
        "run_comparison_v2", HERE / "run_comparison_v2.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 run_comparison_v2.py 以复用规范化哈希。")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUNNER_MODULE = _load_runner_module()


def canonical_json_sha256(value: object) -> str:
    """与 runner 完全同一实现，避免同一 schema 出现两个哈希。"""

    return RUNNER_MODULE.canonical_json_sha256(value)


def _git_blob(commit: str, path: str) -> str:
    return subprocess.run(
        ["git", "show", f"{commit}:{path}"],
        cwd=REPO, check=True, capture_output=True, text=True,
    ).stdout


def _prompt_from_source(source: str) -> str:
    namespace: dict[str, Any] = {}
    exec(compile(source, "<frozen-prompt-source>", "exec"), namespace)  # noqa: S102
    prompt = namespace["SOURCE_VERIFICATION_SYSTEM_PROMPT"]
    if not isinstance(prompt, str) or not prompt.strip():
        raise RuntimeError("提示正文读取失败。")
    return prompt


def compute_arms() -> dict[str, Any]:
    """重算两臂提示正文与候选提示文件哈希。"""

    baseline_source = _git_blob(BASELINE_PROMPT_COMMIT, BASELINE_PROMPT_SOURCE)
    candidate_source_path = REPO / CANDIDATE_PROMPT_SOURCE
    candidate_source = candidate_source_path.read_text(encoding="utf-8")
    baseline_prompt = _prompt_from_source(baseline_source)
    candidate_prompt = _prompt_from_source(candidate_source)
    if baseline_prompt == candidate_prompt:
        raise RuntimeError("基线提示与候选提示相同，无法形成对照。")

    baseline_lines = baseline_prompt.splitlines()
    candidate_lines = candidate_prompt.splitlines()
    diff_lines = list(difflib.unified_diff(
        baseline_lines, candidate_lines, lineterm="", n=0,
    ))
    added = [
        line[1:] for line in diff_lines
        if line.startswith("+") and not line.startswith("+++")
    ]
    removed = [
        line[1:] for line in diff_lines
        if line.startswith("-") and not line.startswith("---")
    ]
    if len(added) != EXPECTED_SINGLE_LEAF_ADDED_LINES or removed:
        raise RuntimeError(
            "候选提示相对基线不是只多既有单叶的 6 行："
            f"新增 {len(added)} 行、删除 {len(removed)} 行。"
        )

    baseline_prompt_sha = _sha256_text(baseline_prompt)
    candidate_prompt_sha = _sha256_text(candidate_prompt)
    if baseline_prompt_sha != EXPECTED_BASELINE_PROMPT_SHA256:
        raise RuntimeError(f"基线提示正文 SHA 变化：{baseline_prompt_sha}")
    if candidate_prompt_sha != EXPECTED_CANDIDATE_PROMPT_SHA256:
        raise RuntimeError(f"候选提示正文 SHA 变化：{candidate_prompt_sha}")

    return {
        "baseline": {
            "prompt_body_sha256": baseline_prompt_sha,
            "prompt_file_path": BASELINE_PROMPT_SOURCE,
            "prompt_file_sha256": _sha256_text(baseline_source),
            "git_blob_sha256": _sha256_text(baseline_source),
            "prompt_chars": len(baseline_prompt),
            "prompt_lines": len(baseline_lines),
            "take_from": {
                "commit": BASELINE_PROMPT_COMMIT,
                "method": (
                    "git show e015b96:src/notalone/memory_extraction/"
                    "verification_adapters.py，再从源码常量 SOURCE_VERIFICATION_SYSTEM_PROMPT "
                    "取提示正文；不在仓库内留会漂移的副本"
                ),
            },
        },
        "candidate": {
            "prompt_body_sha256": candidate_prompt_sha,
            "prompt_file_path": CANDIDATE_PROMPT_SOURCE,
            "prompt_file_sha256": _sha256_file(candidate_source_path),
            "git_blob_sha256": None,
            "prompt_chars": len(candidate_prompt),
            "prompt_lines": len(candidate_lines),
            "take_from": {
                "commit": _head_commit(),
                "method": (
                    "导入当前仓库 notalone.memory_extraction.verification_adapters 的 "
                    "SOURCE_VERIFICATION_SYSTEM_PROMPT；冻结时重算并与 plan 记录的两项 SHA 核对"
                ),
            },
        },
        "single_leaf_delta": {
            "added_lines": len(candidate_lines) - len(baseline_lines),
            "added_line_sha256": [_sha256_text(line) for line in added],
            "note": "候选相对基线只多既有单叶的 6 行，无其他改动。",
        },
    }


def _head_commit() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=REPO, check=True,
        capture_output=True, text=True,
    ).stdout.strip()


def compute_windows() -> list[dict[str, Any]]:
    """从 v1 冻结计划取登记路径，重算输入哈希；只读哈希，不落正文。"""

    v1 = json.loads(V1_PLAN_PATH.read_text(encoding="utf-8"))
    entries = v1["windows"]
    if len(entries) != len(EXPECTED_WINDOW_SHA256):
        raise RuntimeError("v1 冻结计划的窗口数与提案不一致。")
    windows: list[dict[str, Any]] = []
    for index, (entry, expected) in enumerate(
        zip(entries, EXPECTED_WINDOW_SHA256), start=1
    ):
        path = Path(entry["input_path"]).expanduser()
        if not path.is_file():
            raise RuntimeError(f"窗口 {index} 的冻结输入不存在：{path}")
        digest = _sha256_file(path)
        if digest != expected:
            raise RuntimeError(f"窗口 {index} 的输入 SHA 与提案不一致：{digest}")
        if entry["input_sha256"] != expected:
            raise RuntimeError(f"窗口 {index} 的 v1 登记 SHA 与提案不一致。")
        windows.append({
            "window_id": f"W{index}",
            "input_path": str(path),
            "input_sha256": digest,
            "input_bytes": path.stat().st_size,
            "fixture_origin": "已批准匿名 C4 合成材料，正文留在仓库外私有目录，仓库内只登记路径与哈希",
        })
    return windows


def build_schedule() -> dict[str, Any]:
    """按提案第 2.2 节展开 8 个位置 / 16 次调用，并复算轮换平衡。"""

    slots: list[dict[str, Any]] = []
    invocations: list[dict[str, Any]] = []
    sequence = 0
    for exec_order, repeat, window_id, arm_order, per_position in SLOT_ORDER_TABLE:
        window_rank = int(window_id[1:])
        expected_first = "baseline" if (window_rank + repeat) % 2 == 0 else "candidate"
        if arm_order != f"{expected_first}-first":
            raise RuntimeError(
                f"执行序 {exec_order} 的臂序与轮换规则不符：{arm_order} != {expected_first}-first"
            )
        arms = (
            ["baseline", "candidate"] if expected_first == "baseline"
            else ["candidate", "baseline"]
        )
        phase = 1 if repeat <= 2 else 2
        slot_id = f"S{exec_order}"
        slots.append({
            "exec_order": exec_order,
            "slot_id": slot_id,
            "phase": phase,
            "window_id": window_id,
            "repeat": f"r{repeat}",
            "arm_order": arm_order,
            "first_arm": arms[0],
            "arms": arms,
            "invokes": per_position,
        })
        for arm_index, arm in enumerate(arms, start=1):
            sequence += 1
            invocations.append({
                "sequence": sequence,
                "slot_id": slot_id,
                "exec_order": exec_order,
                "phase": phase,
                "window_id": window_id,
                "repeat": f"r{repeat}",
                "arm": arm,
                "arm_index_in_slot": arm_index,
            })
    if len(slots) != 8 or len(invocations) != 16:
        raise RuntimeError("顺序表规模不是 8 个位置 / 16 次调用。")
    first_counts = {"baseline": 0, "candidate": 0}
    per_window_first: dict[str, dict[str, int]] = {
        "W1": {"baseline": 0, "candidate": 0},
        "W2": {"baseline": 0, "candidate": 0},
    }
    for slot in slots:
        first_counts[slot["first_arm"]] += 1
        per_window_first[slot["window_id"]][slot["first_arm"]] += 1
    if first_counts != {"baseline": 4, "candidate": 4}:
        raise RuntimeError(f"臂序不平衡：{first_counts}")
    for window_id, counts in per_window_first.items():
        if counts != {"baseline": 2, "candidate": 2}:
            raise RuntimeError(f"{window_id} 的臂序不平衡：{counts}")
    return {
        "rotation_rule": "（窗口序号 + 重复序号）为偶数时 baseline 先，为奇数时 candidate 先；不做运行时随机",
        "execution_rule": "按重复轮次交替执行两个窗口，避免时间漂移集中在单个窗口",
        "phase_rule": "阶段 1 用 r1／r2（8 次），阶段 2 用 r3／r4（8 次）；阶段 1 判败即永久关闭阶段 2",
        "slots": slots,
        "invocations": invocations,
        "balance": {
            "baseline_first_slots": first_counts["baseline"],
            "candidate_first_slots": first_counts["candidate"],
            "per_window_first": per_window_first,
            "per_arm_positions": {"baseline": 8, "candidate": 8},
            "per_arm_positions_per_window": 4,
        },
    }


def build_plan() -> dict[str, Any]:
    arms = compute_arms()
    windows = compute_windows()
    schedule = build_schedule()
    proposal_sha = _sha256_file(PROPOSAL_PATH)
    return {
        "kind": "memory-core-claim-retention-product-prompt-repetition-comparison-v2",
        "status": "prepared-pending-credential",
        "ticket": {
            "issue": ".scratch/memory-core-claim-retention/issues/01-diagnose-fix-and-replay.md",
            "proposal": str(PROPOSAL_PATH.relative_to(REPO)),
            "proposal_sha256": proposal_sha,
            "proposal_lines": len(PROPOSAL_PATH.read_text(encoding="utf-8").splitlines()),
            "approval": {
                "approved_by": "用户",
                "approved_on": "2026-10-05",
                "approved_budget": "16 次公开 V 调用（2 窗口 × 4 重复 × 2 臂，E=0／V=16／R=0）",
                "approved_disposition": (
                    "结果为有害时另开回滚票、不在本轮改产品默认；不补跑、不调参、不加臂"
                ),
                "state_or_triage_changed_by_this_plan": False,
            },
            "question": (
                "在重复测量下，已并入产品默认的“转述支持单叶”是否稳定降低来源核验的"
                "不必要降级，并且不引入坏 auto、硬拒或字段漂移？"
            ),
            "explicitly_not_answered": (
                "6/12 严格覆盖属 E 侧指标，本轮是 V-only 对照，不含提取调用，"
                "结论不外推真实聊天分布。"
            ),
        },
        "sources": {
            "head_commit": _head_commit(),
            "baseline_prompt_commit": BASELINE_PROMPT_COMMIT,
            "verification_adapters_path": CANDIDATE_PROMPT_SOURCE,
            "verification_adapters_file_sha256": arms["candidate"]["prompt_file_sha256"],
            "baseline_verification_adapters_file_sha256": arms["baseline"][
                "git_blob_sha256"
            ],
            "schema_sha256": None,  # 由 compute_schema_sha256 填充
            "runner_script": str(
                (HERE / "run_comparison_v2.py").relative_to(REPO)
            ),
            "runner_script_sha256": _sha256_file(HERE / "run_comparison_v2.py"),
            "prepare_script": str(Path(__file__).resolve().relative_to(REPO)),
            "prepare_script_sha256": _sha256_file(Path(__file__).resolve()),
            "source_sha256_note": (
                "运行源码按文件原始字节取 SHA256（与编码无关）；"
                "schema_sha256 用 canonical_json_sha256 规范化后取 SHA256"
                "（ensure_ascii=False、sort_keys=True、无多余空白）。"
            ),
            "schema_sha256_method": (
                'json.dumps(value, ensure_ascii=False, sort_keys=True, '
                'separators=(",", ":")) 后按 UTF-8 取 sha256'
            ),
            "type_check": {
                "command": (
                    "python -m mypy --no-incremental --cache-dir=/dev/null "
                    "--follow-imports=skip --ignore-missing-imports "
                    "--check-untyped-defs <runner> <prepare> <测试文件>"
                ),
                "note": "禁用增量缓存，只检查本轮三个文件；不声称全仓库类型通过。",
            },
        },
        "scope": {
            "purpose": arms["single_leaf_delta"]["note"],
            "arms": [
                "baseline：提交 e015b96 的改动前产品提示（从 git 取，不在仓库留副本）",
                "candidate：当前仓库 SOURCE_VERIFICATION_SYSTEM_PROMPT（已含转述支持单叶）",
            ],
            "only_difference": "system 提示正文；工具 schema 与 user 消息两臂逐字节相同",
            "arms_detail": arms,
            "windows": len(windows),
            "repeats": 4,
            "arms_count": 2,
            "max_public_invokes": 16,
            "E": 0,
            "V": 16,
            "R": 0,
            "provider": "only existing ECNU endpoint (chat.ecnu.edu.cn/open/api/v1)",
            "model": "ecnu-max",
            "thinking": "enabled",
            "official_deepseek_endpoint_or_key": False,
            "fallback_provider": "none",
            "temperature": 0.0,
            "writes_to_business_data": False,
            "reads_real_chat_or_holdout": False,
        },
        "windows": windows,
        "schedule": schedule,
        "position_criteria": {
            "frozen_before_run": True,
            "place": "私有输出目录的 position-criteria-v2.json（调用前写入）",
            "per_position_expected": "supported 且 issues=[]",
            "basis": "两个窗口都是完整合法正例：原话完整支持、原 14 字段正确、无真实歧义",
            "derivation_rules": {
                "structural_valid": "唯一 tool_call、名字为 SourceVerificationOutput、args 只含 results、恰好 1 条 item、verdict 取值合法、issues 为字符串数组、evidence 为数组",
                "downgrade": "verdict 为 uncertain／unsupported，或 supported 且 issues 非空",
                "hard_reject": "verdict 为 unsupported",
                "bad_auto": "verdict 为 supported 且 issues 非空：在已知完整合法正例上既确认主张又标记问题，正文或字段必有一处确定错误（判败哨兵；不声称线上 auto 采纳数）",
                "stays_pending": "本轮候选均为 report／reported，预期保持 pending",
                "field_fidelity": "V 不改正文；两臂输入逐字相同，故字段保真为输入属性",
            },
            "judge": (
                "位置级判据由 Agent 判定，不是用户确认，也不能当作模型真值；"
                "本条沿用之前的诚实说明"
            ),
        },
        "metrics": {
            "primary": {
                "name": "不必要降级率",
                "definition": (
                    "该臂 8 个位置中，返回 uncertain／unsupported，或 supported 但 issues 非空的"
                    "位置数 ÷ 8；分母固定为 8"
                ),
                "denominator": 8,
            },
            "failure_and_empty_counted": True,
            "secondary": [
                "坏 auto（判败哨兵）：编译后进入 auto 且正文或字段有确定错误的位置数，预期 0",
                "硬拒：完整合法正例被判 unsupported 的位置数，预期 0",
                "转述候选保持 pending：report／reported 候选每臂 8/8 保持待确认",
                "字段保真：编译后事实与原 14 字段逐字段一致（V 不改正文），任一处漂移记为结构失败",
                "运行指标：结构合法返回率、空返回、协议失败、未运行、耗时、SDK reported tokens",
                "raw／接受／完整契约三层统计：逐位置同时记 raw 返回、接受结果和完整契约结果",
            ],
            "pseudo_replication_note": (
                "8 个位置只来自 2 个材料窗口，属于伪重复，不构成 8 个独立场景；"
                "本轮只做位置计数比较，不做显著性推断，也不据此外推真实聊天分布。"
            ),
            "unobservable_signal_note": (
                "若两臂降级位置数都为 0，记为“本轮没有可观测的对照信号”，"
                "不得当作收益通过，也不自动追加预算。"
            ),
        },
        "gates": {
            "phase1": {
                "phase": 1,
                "invokes": 8,
                "uses_repeats": ["r1", "r2"],
                "on_failure": "立即判败闭账，并永久关闭阶段 2 的 8 次调用",
                "checks": {
                    "G1-a": {
                        "name": "完整性",
                        "requirement": "8/8 位置返回结构合法的工具调用；0 协议失败、0 空返回、0 未运行",
                        "threshold": {"structurally_valid": 8, "protocol_failures": 0,
                                      "empty_returns": 0, "not_run": 0},
                    },
                    "G1-b": {
                        "name": "安全",
                        "requirement": "两臂坏 auto = 0；两臂硬拒 = 0",
                        "threshold": {"bad_auto": 0, "hard_reject": 0},
                    },
                    "G1-c": {
                        "name": "方向",
                        "requirement": "候选臂降级位置数 ≤ 基线臂，且候选臂 ≤ 1（阶段内每臂 4 个位置的 1/4）",
                        "threshold": {"candidate_le_baseline": True, "candidate_max": 1},
                        "candidate_max_kind": "拟议值",
                    },
                },
            },
            "phase2": {
                "phase": 2,
                "invokes": 8,
                "uses_repeats": ["r3", "r4"],
                "combined_positions": 16,
                "safety_gate": {
                    "name": "安全门",
                    "requirement": "两臂坏 auto = 0；硬拒 = 0；转述候选 pending = 16/16",
                    "threshold": {"bad_auto": 0, "hard_reject": 0, "pending": 16},
                },
                "runtime_gate": {
                    "name": "运行门",
                    "requirement": "16/16 位置结构合法；单臂失败或空返回 ≤ 1，且照计分母；超出则判“证据不足”",
                    "threshold": {"structurally_valid": 16, "per_arm_failures_or_empty_max": 1},
                    "per_arm_failures_or_empty_max_kind": "拟议值",
                    "on_failure": "证据不足",
                },
                "main_judgment": {
                    "name": "主判定",
                    "requirement": "候选降级位置数 < 基线 → 有收益；= 基线 → 无差异；> 基线 → 有害",
                    "branches": {
                        "benefit": "candidate < baseline",
                        "no_difference": "candidate == baseline 且两臂都 > 0",
                        "harmful": "candidate > baseline",
                        "no_observable_signal": "两臂都为 0（不等同收益，不自动追加预算）",
                    },
                },
                "decision_table": [
                    {"safety_runtime": "通过", "main_judgment": "有收益",
                     "next": "记录“单叶在这 2 个匿名窗口上稳定降低不必要降级”；产品默认保持现状，不外推真实聊天"},
                    {"safety_runtime": "通过", "main_judgment": "无差异",
                     "next": "记录“未观察到收益，也未观察到危害”；不回滚、不宣称提升，按“验证完成、收益未证明”结项"},
                    {"safety_runtime": "通过", "main_judgment": "有害",
                     "next": "结论建议回滚；另开实现票，取得用户批准后才改提示，本轮不改产品默认"},
                    {"safety_runtime": "失败", "main_judgment": "任意",
                     "next": "判败闭账；若安全门失败，另开票评估单叶去留；不补跑、不调参、不加臂"},
                ],
            },
        },
        "budget": {
            "max_public_invokes": 16,
            "E": 0,
            "V": 16,
            "R": 0,
            "phase1_invokes": 8,
            "phase2_invokes": 8,
            "phase2_closes_permanently_if_phase1_fails": True,
            "failure_and_empty_still_count": True,
            "no_retry_no_backfill_no_extra_arm": True,
            "closed_budgets_not_reopened": [
                "2026-10-04 人物路线余量",
                "同轮 24 次",
                "此前 114／127／199 等已关闭余额",
            ],
            "cost_reference": (
                "非承诺：2026-10-03 的 8 次 V-only 对照报告 22,701 tokens，"
                "据此 16 次预计数万 tokens；运行后只报 SDK reported tokens，不报猜测值"
            ),
        },
        "isolation": {
            "private_output_dir": "~/.notalone/audits/memory-claim-retention-repetition-20261005",
            "private_dir_mode": "0700",
            "private_file_mode": "0600",
            "in_git": False,
            "repo_keeps": "不含正文的计划与脚本",
            "credential_read_after_all_freezes": True,
            "dry_run_before_credential_read": True,
        },
        "boundaries": {
            "reads_real_chat": False,
            "reads_actual_or_held_holdout": False,
            "reads_other_contacts": False,
            "reads_credentials_during_dry_run": False,
            "writes_business_memory_watermark_or_product_default": False,
            "changes_product_source": False,
            "changes_existing_ticket_state_or_triage": False,
            "remote_git_operations": False,
            "new_protocol_fields_or_model_stages": False,
        },
        "limitations": [
            "模型非确定性是主要干扰；重复测量与臂序轮换只能平摊，不能消除；结论以位置计数差异表述，不用比率置信区间。",
            "只有 2 个材料窗口，每臂 8 个位置是伪重复；即使结果一致，也只说明这 2 个窗口上的行为。",
            "单次返回即可翻转小样本判定，因此把“证据不足”写成正式结项类别。",
            "服务侧缓存、隐藏 thinking 不可读、端点抖动、日内漂移都可能影响单次返回；两臂交替与窗口轮换只处理顺序效应。",
            "本轮不含负例，坏 auto 只是若出现即判败的哨兵，不能当作安全性的完整证据。",
            "位置级判据由 Agent 判定，不是用户确认，也不能当作模型真值；模型置信度不等于实测准确率。",
            "基线臂提示来自 git 历史提交；若 e015b96 之后产品提示再变，冻结时必须重新核对候选臂 SHA 与当前仓库逐字一致，否则停止并重做冻结。",
        ],
        "not_doing": [
            "不切产品默认：不改 SOURCE_VERIFICATION_SYSTEM_PROMPT、schema、ExtractionFlow、PragmaticInterpreter、窄 guard 或采纳门；即使结果有害，也只出结论，回滚另开票并需用户批准。",
            "不重开旧预算：不借用任何已关闭余额，不复开 2026-10-04 的余量。",
            "不补跑、不调参、不加臂：失败位置不重试，不调提示措辞，不循环加轮次，不中途换模型（不试 ecnu-plus，不用官方端点）。",
            "不读真实资料、不进留出：不读真实聊天、actual／held 留出，不做同批自然聊天复测。",
            "不写业务数据：不写业务记忆、水位、旧五条资料、产品默认或远端 Git。",
            "不宣称修复覆盖：不把本轮结果等同于 6/12 改善或整体记忆准确率修复；本轮不含 E。",
            "不引入新协议：不新增字段、不新增模型阶段、不改公开 Seam。",
        ],
    }


def _verification_schema() -> dict[str, Any]:
    sys.path.insert(0, str(REPO / "src"))
    from notalone.memory_extraction.verification_adapters import (
        SOURCE_VERIFICATION_SCHEMA,
    )

    return SOURCE_VERIFICATION_SCHEMA


def compute_schema_sha256() -> str:
    """核验工具 schema 的规范化 SHA256；与 runner 共用同一实现。"""

    return canonical_json_sha256(_verification_schema())


def main() -> int:
    parser = argparse.ArgumentParser(description="冻结重复测量对照计划（不调用模型）")
    parser.add_argument(
        "--check", action="store_true",
        help="只重算并核对已冻结计划，不写文件",
    )
    args = parser.parse_args()

    plan = build_plan()
    plan["sources"]["schema_sha256"] = compute_schema_sha256()

    if args.check:
        if not PLAN_PATH.is_file():
            print(f"缺少冻结计划：{PLAN_PATH}")
            return 1
        frozen = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
        for key in ("scope", "windows", "schedule", "gates", "budget"):
            if frozen.get(key) != plan.get(key):
                print(f"冻结计划与重算结果不一致：{key}")
                return 1
        # 运行源码与 schema 哈希逐项核对（head_commit／提案 SHA 属于会随
        # 提交与文档改动变化的元数据，不在这里比对）。
        frozen_sources = frozen.get("sources") or {}
        for key in (
            "runner_script", "runner_script_sha256",
            "prepare_script", "prepare_script_sha256",
            "schema_sha256", "schema_sha256_method",
        ):
            if frozen_sources.get(key) != plan["sources"].get(key):
                print(f"冻结计划与重算结果不一致：sources.{key}")
                return 1
        print("冻结计划重算一致（含运行源码与规范化 schema SHA）。")
        return 0

    PLAN_PATH.write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    print(f"已冻结：{PLAN_PATH}")
    print(
        "窗口输入 SHA："
        + "、".join(window["input_sha256"][:8] for window in plan["windows"])
    )
    print(
        "提示正文 SHA：baseline "
        + plan["scope"]["arms_detail"]["baseline"]["prompt_body_sha256"][:8]
        + "（git " + BASELINE_PROMPT_COMMIT + "）、candidate "
        + plan["scope"]["arms_detail"]["candidate"]["prompt_body_sha256"][:8]
    )
    print(
        "计划调用上限："
        f"{plan['budget']['max_public_invokes']}（E={plan['budget']['E']}／"
        f"V={plan['budget']['V']}／R={plan['budget']['R']}）"
    )
    print(
        "运行源码 SHA：runner "
        + plan["sources"]["runner_script_sha256"][:8]
        + "、prepare "
        + plan["sources"]["prepare_script_sha256"][:8]
    )
    print("核验 schema 规范化 SHA256：" + plan["sources"]["schema_sha256"])
    print("输入正文留在仓库外私有目录，计划内只记录路径与哈希。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

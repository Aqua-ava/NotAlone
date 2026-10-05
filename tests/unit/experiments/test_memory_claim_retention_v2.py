"""票 01 重复测量对照（v2）冻结计划与 runner 的确定性行为验证。

本测试只覆盖不需要凭据、不联网的部分：冻结计划的顺序表与预算、两臂提示 SHA、
运行源码 SHA（提案第 4 节）、统一的规范化 schema SHA、分阶段门判定、
失败与空返回计入分母、dry-run 不读凭据，以及 SDK 合成凭据的“只绑定”检查。
真实调用路径不在单元测试范围内（本轮 0 次真实运行）。

加载方式：runner 位于 `.scratch/`，按既有惯例用 importlib 从路径加载，但**只在
`setUpClass` 里加载**，并在类创建后挂 `unittest.skipUnless`；脚本缺失时 14 个
依赖 runner 的测试类整体记为 skipped，而不是让 `unittest discover` 在收集阶段
崩溃。`RunnerMissingScriptSkipProofTest` 本身不依赖脚本：它把本模块复制到临时
仓库副本（runner 缺失）里，在子进程里确认该副本 import 成功、守卫标记齐全，
因此脚本缺失时它仍然运行并通过。

记录位置：本模块同时是提案第 7.2 节「SDK 合成凭据只绑定」的仓库内记录
（见 `SyntheticCredentialBindingTest`：只用自造合成 key，只断言具名工具与
schema 绑定成功，不证明真实调用可用）。
"""

from __future__ import annotations

import ast
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import ModuleType
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[3]
V2_DIR = REPO / ".scratch" / "memory-core-claim-retention" / "product-prompt-comparison-v2"
PLAN_PATH = V2_DIR / "frozen-plan-v2.json"
RUNNER_PATH = V2_DIR / "run_comparison_v2.py"
PREPARE_PATH = V2_DIR / "prepare_comparison_v2.py"
VERIFICATION_ADAPTERS = (
    REPO / "src" / "notalone" / "memory_extraction" / "verification_adapters.py"
)
BASELINE_PROMPT_COMMIT = "e015b96"

# 只用于「只绑定」检查的合成 key：不是真实凭据，不写入仓库任何产物，也不联网。
SYNTHETIC_KEY = "sk-synthetic-notalone-binding-check-0000000000000000"
SYNTHETIC_BASE_URL = "https://chat.ecnu.edu.cn/open/api/v1"

# 缺失场景用临时仓库副本，不改动仓库里的 `.scratch/` 脚本：
# `_temp_repo_copy` 会把本模块复制到没有 runner 的临时仓库下。

# 依赖 runner 的测试类（缺失时整体跳过）；由 RunnerMissingScriptSkipProofTest 使用。
RUNNER_DEPENDENT_TEST_CLASSES: tuple[str, ...] = ()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_runner(path: Path | None = None) -> ModuleType:
    """从路径加载 runner 模块；只在 `setUpClass`（或缺失证明测试）里调用。"""

    target = path or RUNNER_PATH
    spec = importlib.util.spec_from_file_location("run_comparison_v2", target)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_PLAN_CACHE: dict = {}


def _plan() -> dict:
    """读冻结计划；按文件 mtime／大小失效，并返回副本以免测试互相污染。"""

    stamp = PLAN_PATH.stat().st_mtime_ns, PLAN_PATH.stat().st_size
    if _PLAN_CACHE.get("stamp") != stamp:
        _PLAN_CACHE["stamp"] = stamp
        _PLAN_CACHE["plan"] = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    return copy.deepcopy(_PLAN_CACHE["plan"])


class RunnerBackedTest(unittest.TestCase):
    """runner 依赖测试的基类：在 `setUpClass` 加载，缺失则整类跳过。

    不在 import 期加载 runner，是为了让 `unittest discover` 在脚本缺失时
    仍然能收集本模块：收集阶段不读 `.scratch/`，运行前由 `unittest.skipUnless`
    把这一类测试记为跳过，而不是把收集整体判为 error。
    """

    runner: ModuleType

    @classmethod
    def setUpClass(cls) -> None:
        # 正常路径下 skipUnless 已在运行前拦下缺失情况；这里的断言是防御性的，
        # 保证守卫被误删时立刻失败而不是悄悄跑到 FileNotFoundError。
        if not RUNNER_PATH.is_file():
            raise AssertionError(
                f"runner 守卫失效：脚本缺失时不应进入 setUpClass（{RUNNER_PATH}）"
            )
        cls.runner = _load_runner()


def _baseline_prompt_text() -> str:
    source = subprocess.run(
        [
            "git", "show",
            f"{BASELINE_PROMPT_COMMIT}:src/notalone/memory_extraction/"
            "verification_adapters.py",
        ],
        cwd=REPO, check=True, capture_output=True, text=True,
    ).stdout
    namespace: dict = {}
    exec(compile(source, "<test-baseline>", "exec"), namespace)  # noqa: S102
    return namespace["SOURCE_VERIFICATION_SYSTEM_PROMPT"]


def _position(phase: int, arm: str, index: int) -> dict:
    """返回冻结顺序表里某臂第 index（0 起）个位置的调用条目。"""

    entries = [
        entry for entry in _plan()["schedule"]["invocations"]
        if entry["phase"] == phase and entry["arm"] == arm
    ]
    return entries[index]


def _base_record(phase: int = 1, arm: str = "baseline", index: int = 0,
                 **overrides: object) -> dict:
    """构造一条完整的位置记录，默认是已知合法正例的通过形态。"""

    entry = _position(phase, arm, index)
    record: dict = {
        "sequence": entry["sequence"],
        "slot_id": entry["slot_id"],
        "exec_order": entry["exec_order"],
        "phase": phase,
        "window_id": entry["window_id"],
        "repeat": entry["repeat"],
        "arm": arm,
        "arm_index_in_slot": entry["arm_index_in_slot"],
        "invoked": True,
        "structural_valid": True,
        "failure": None,
        "empty_return": False,
        "protocol_failure": False,
        "not_run": False,
        "verdict": "supported",
        "issues": [],
        "hard_reject": False,
        "bad_auto": False,
        "stays_pending": True,
        "field_fidelity": True,
    }
    record.update(overrides)
    return record


def _with(
    phase: int, arm: str, index: int, **overrides: object
) -> dict:
    """取冻结顺序表里的位置并覆盖若干字段；未覆盖字段沿用“通过”形态。"""

    record = _base_record(phase, arm, index)
    if "verdict" in overrides:
        verdict = overrides["verdict"]
        issues = overrides.get("issues", [])
        record["hard_reject"] = verdict == "unsupported"
        record["bad_auto"] = verdict == "supported" and bool(issues)
    record.update(overrides)
    for flag in ("bad_auto", "hard_reject"):
        if flag in overrides:
            record[flag] = overrides[flag]
    return record


def _override(records: list[dict], sequence: int, **overrides: object) -> dict:
    """就地覆盖某个调用序号的字段；序号与冻结顺序表一致。"""

    record = next(item for item in records if item["sequence"] == sequence)
    if "verdict" in overrides:
        verdict = overrides["verdict"]
        issues = overrides.get("issues", [])
        record["hard_reject"] = verdict == "unsupported"
        record["bad_auto"] = verdict == "supported" and bool(issues)
    record.update(overrides)
    for flag in ("bad_auto", "hard_reject"):
        if flag in overrides:
            record[flag] = overrides[flag]
    return record


def _records(
    phase: int,
    arm_verdicts: dict[str, list[tuple[str, list[str]]]],
) -> list[dict]:
    """按冻结顺序表生成该阶段的 8 条位置记录。

    键是臂名，值是该臂 4 个位置的 (verdict, issues)。记录顺序与冻结顺序表一致，
    长度固定等于该阶段的计划位置数（8），失败与空返回照占位、不补位。
    """

    records: list[dict] = []
    for entry in _plan()["schedule"]["invocations"]:
        if entry["phase"] != phase:
            continue
        verdict, issues = arm_verdicts[entry["arm"]][
            _arm_position_index(entry)
        ]
        records.append(_with(
            phase, entry["arm"], _arm_position_index(entry),
            verdict=verdict, issues=list(issues),
        ))
    return records


def _arm_position_index(entry: dict) -> int:
    """某个调用在它自己那一臂 4 个位置中的序号（0 起）。"""

    same_arm = [
        item for item in _plan()["schedule"]["invocations"]
        if item["phase"] == entry["phase"] and item["arm"] == entry["arm"]
    ]
    return same_arm.index(entry)


def _all_supported(phase: int = 1) -> list[dict]:
    return _records(phase, {
        "baseline": [("supported", [])] * 4,
        "candidate": [("supported", [])] * 4,
    })


def _balanced_phase2(
    candidate_repeats: int, baseline_repeats: int
) -> list[dict]:
    """构造全部 16 条位置记录（阶段 1 全通过 + 阶段 2 指定降级次数）。"""

    def arm(downgrades: int) -> list[tuple[str, list[str]]]:
        return [
            ("uncertain", ["pragmatics"]) if index < downgrades else ("supported", [])
            for index in range(4)
        ]

    records = _records(1, {
        "baseline": [("supported", [])] * 4,
        "candidate": [("supported", [])] * 4,
    })
    records.extend(_records(2, {
        "baseline": arm(baseline_repeats),
        "candidate": arm(candidate_repeats),
    }))
    return records


class FrozenPlanV2Test(RunnerBackedTest):
    """冻结计划本身必须可校验、自洽，并与提案第 2.2 节一致。"""

    def test_plan_loads_and_has_expected_kind_and_status(self) -> None:
        plan = self.runner.load_plan()
        self.assertEqual(plan["status"], "prepared-pending-credential")
        self.assertEqual(plan["budget"]["max_public_invokes"], 16)
        self.assertEqual(
            (plan["budget"]["E"], plan["budget"]["V"], plan["budget"]["R"]),
            (0, 16, 0),
        )
        self.assertNotIn("executed", json.dumps(plan, ensure_ascii=False))

    def test_plan_rejects_a_tampered_schedule(self) -> None:
        plan = _plan()
        plan["schedule"]["slots"][1]["arm_order"] = "baseline-first"
        with self.assertRaises(self.runner.PlanError):
            self.runner.validate_plan(plan)

    def test_plan_rejects_budget_drift(self) -> None:
        plan = _plan()
        plan["budget"]["max_public_invokes"] = 24
        with self.assertRaises(self.runner.PlanError):
            self.runner.validate_plan(plan)

    def test_plan_rejects_a_reopened_phase_two(self) -> None:
        plan = _plan()
        plan["budget"]["phase2_closes_permanently_if_phase1_fails"] = False
        with self.assertRaises(self.runner.PlanError):
            self.runner.validate_plan(plan)


class ScheduleRotationTest(RunnerBackedTest):
    """顺序表轮换必须 4/4 平衡，且与提案第 2.2 节表格逐行一致。"""

    def test_slots_match_the_proposal_table_row_by_row(self) -> None:
        expected = [
            (1, 1, "W1", "baseline-first"),
            (2, 1, "W2", "candidate-first"),
            (3, 2, "W1", "candidate-first"),
            (4, 2, "W2", "baseline-first"),
            (5, 3, "W1", "baseline-first"),
            (6, 3, "W2", "candidate-first"),
            (7, 4, "W1", "candidate-first"),
            (8, 4, "W2", "baseline-first"),
        ]
        slots = _plan()["schedule"]["slots"]
        self.assertEqual(
            [
                (slot["exec_order"], int(slot["repeat"][1:]), slot["window_id"],
                 slot["arm_order"])
                for slot in slots
            ],
            expected,
        )

    def test_four_baseline_first_and_four_candidate_first(self) -> None:
        slots = _plan()["schedule"]["slots"]
        firsts = [slot["first_arm"] for slot in slots]
        self.assertEqual(firsts.count("baseline"), 4)
        self.assertEqual(firsts.count("candidate"), 4)

    def test_each_window_has_two_of_each_first_arm(self) -> None:
        slots = _plan()["schedule"]["slots"]
        for window_id in ("W1", "W2"):
            firsts = [
                slot["first_arm"] for slot in slots if slot["window_id"] == window_id
            ]
            self.assertEqual(firsts.count("baseline"), 2)
            self.assertEqual(firsts.count("candidate"), 2)

    def test_rotation_rule_holds_for_every_slot(self) -> None:
        for slot in _plan()["schedule"]["slots"]:
            window_rank = int(slot["window_id"][1:])
            repeat = int(slot["repeat"][1:])
            expected_first = (
                "baseline" if (window_rank + repeat) % 2 == 0 else "candidate"
            )
            self.assertEqual(slot["first_arm"], expected_first)
            self.assertEqual(slot["arms"], [expected_first, slot["arms"][1]])

    def test_sixteen_invocations_with_eight_positions_per_arm(self) -> None:
        invocations = _plan()["schedule"]["invocations"]
        self.assertEqual(len(invocations), 16)
        self.assertEqual(
            [entry["arm"] for entry in invocations].count("baseline"), 8
        )
        self.assertEqual(
            [entry["arm"] for entry in invocations].count("candidate"), 8
        )
        self.assertEqual(
            [entry["sequence"] for entry in invocations], list(range(1, 17))
        )

    def test_phase_split_is_eight_and_eight(self) -> None:
        invocations = _plan()["schedule"]["invocations"]
        phase1 = [entry for entry in invocations if entry["phase"] == 1]
        phase2 = [entry for entry in invocations if entry["phase"] == 2]
        self.assertEqual((len(phase1), len(phase2)), (8, 8))
        self.assertEqual({entry["repeat"] for entry in phase1}, {"r1", "r2"})
        self.assertEqual({entry["repeat"] for entry in phase2}, {"r3", "r4"})


class ArmPromptHashTest(RunnerBackedTest):
    """两臂提示的 SHA 必须与当前仓库、git 历史提交一致。"""

    def test_candidate_prompt_body_sha_matches_the_current_repository(self) -> None:
        plan = _plan()
        recorded = plan["scope"]["arms_detail"]["candidate"]["prompt_body_sha256"]
        self.assertEqual(
            self.runner.check_prompt_integrity(plan)["candidate"]["prompt_body_sha256"],
            recorded,
        )

    def test_candidate_prompt_file_sha_matches_the_repository_file(self) -> None:
        plan = _plan()
        recorded = plan["scope"]["arms_detail"]["candidate"]["prompt_file_sha256"]
        self.assertEqual(
            hashlib.sha256(VERIFICATION_ADAPTERS.read_bytes()).hexdigest(),
            recorded,
        )
        self.assertEqual(
            self.runner.check_prompt_integrity(plan)["candidate"]["prompt_file_sha256"],
            recorded,
        )

    def test_baseline_prompt_comes_from_git_and_differs_from_candidate(self) -> None:
        plan = _plan()
        result = self.runner.check_prompt_integrity(plan)
        recorded = plan["scope"]["arms_detail"]["baseline"]["prompt_body_sha256"]
        self.assertEqual(result["baseline"]["prompt_body_sha256"], recorded)
        self.assertEqual(
            result["baseline"]["prompt_body_sha256"],
            _sha256_text(_baseline_prompt_text()),
        )
        self.assertNotEqual(
            result["baseline"]["prompt_body_sha256"],
            result["candidate"]["prompt_body_sha256"],
        )

    def test_baseline_and_candidate_differ_only_by_the_existing_six_line_leaf(
        self,
    ) -> None:
        import difflib

        baseline = _baseline_prompt_text().splitlines()
        candidate = self.runner.arm_prompts(_plan())["candidate"].splitlines()
        diff = list(difflib.unified_diff(baseline, candidate, lineterm="", n=0))
        added = [
            line for line in diff
            if line.startswith("+") and not line.startswith("+++")
        ]
        removed = [
            line for line in diff
            if line.startswith("-") and not line.startswith("---")
        ]
        self.assertEqual(len(added), 6)
        self.assertEqual(removed, [])


class SourceHashIntegrityTest(RunnerBackedTest):
    """冻结计划必须记录运行源码 SHA，runner 必须实际校验它。

    提案第 4 节要求冻结运行源码；这里同时核对「记录值 == 工作区文件」和
    「校验函数对当前仓库通过、对篡改记录报错」。
    """

    def test_runner_script_sha_is_recorded_and_matches_the_working_tree(self) -> None:
        plan = _plan()
        recorded = plan["sources"]["runner_script_sha256"]
        self.assertEqual(recorded, _sha256_file(_plan_relative(plan["sources"]["runner_script"])))
        self.assertEqual(
            self.runner.check_source_integrity(plan)["runner_script_sha256"],
            recorded,
        )

    def test_prepare_script_sha_is_recorded_and_matches_the_working_tree(self) -> None:
        plan = _plan()
        recorded = plan["sources"]["prepare_script_sha256"]
        self.assertEqual(
            recorded, _sha256_file(_plan_relative(plan["sources"]["prepare_script"]))
        )
        self.assertEqual(
            self.runner.check_source_integrity(plan)["prepare_script_sha256"],
            recorded,
        )

    def test_recorded_script_paths_point_at_the_frozen_scripts(self) -> None:
        plan = _plan()
        self.assertEqual(
            Path(plan["sources"]["runner_script"]).name, RUNNER_PATH.name
        )
        self.assertEqual(
            Path(plan["sources"]["prepare_script"]).name, PREPARE_PATH.name
        )
        self.assertEqual(_plan_relative(plan["sources"]["runner_script"]).resolve(),
                         RUNNER_PATH.resolve())
        self.assertEqual(_plan_relative(plan["sources"]["prepare_script"]).resolve(),
                         PREPARE_PATH.resolve())

    def test_a_tampered_runner_source_hash_is_rejected(self) -> None:
        plan = _plan()
        plan["sources"]["runner_script_sha256"] = "0" * 64
        with self.assertRaises(self.runner.PlanError):
            self.runner.check_source_integrity(plan)

    def test_a_tampered_prepare_source_hash_is_rejected(self) -> None:
        plan = _plan()
        plan["sources"]["prepare_script_sha256"] = "0" * 64
        with self.assertRaises(self.runner.PlanError):
            self.runner.check_source_integrity(plan)

    def test_sources_block_declares_the_sha_normalization(self) -> None:
        sources = _plan()["sources"]
        for key in ("runner_script_sha256", "prepare_script_sha256"):
            self.assertRegex(sources[key], r"^[0-9a-f]{64}$")
        self.assertIn("sha256", sources["source_sha256_note"].lower())
        observed = self.runner.check_source_integrity(_plan())
        for key in ("runner_script_sha256", "prepare_script_sha256"):
            self.assertIn(key, observed)
            self.assertIn("字节", observed[f"{key}_method"])


class SchemaHashNormalizationTest(RunnerBackedTest):
    """prepare 与 runner 必须用同一个规范化函数得到同一个 schema SHA。"""

    def test_prepare_and_runner_compute_the_same_schema_sha(self) -> None:
        prepare = _load_prepare_module()
        self.assertEqual(
            prepare.compute_schema_sha256(),
            self.runner.compute_schema_sha256(),
            "prepare 与 runner 的 schema SHA 必须一致",
        )

    def test_schema_sha_matches_the_frozen_plan(self) -> None:
        plan = _plan()
        recorded = plan["sources"]["schema_sha256"]
        self.assertEqual(self.runner.compute_schema_sha256(), recorded)
        self.assertEqual(self.runner.check_schema_integrity(plan), recorded)

    def test_canonical_form_is_utf8_compact_and_key_sorted(self) -> None:
        """规范化必须保留中文原文（ensure_ascii=False）、紧凑且按键排序。"""

        value = {"b": "中文", "a": [1, 2]}
        expected = hashlib.sha256(
            '{"a":[1,2],"b":"中文"}'.encode("utf-8")
        ).hexdigest()
        self.assertEqual(self.runner.canonical_json_sha256(value), expected)

    def test_validated_schema_fixture_still_produces_two_distinct_hashes(self) -> None:
        """两种旧口径仍然不同：统一后只保留规范化那一个。"""

        schema = json.loads(
            json.dumps(_verification_schema(), ensure_ascii=False, sort_keys=True)
        )
        legacy_prepare = _sha256_text(json.dumps(schema, sort_keys=True))
        legacy_runner = _sha256_text(
            json.dumps(schema, ensure_ascii=False, sort_keys=True)
        )
        self.assertNotEqual(legacy_prepare, legacy_runner)

    def test_a_tampered_schema_hash_is_rejected(self) -> None:
        plan = _plan()
        plan["sources"]["schema_sha256"] = "f" * 64
        with self.assertRaises(self.runner.PlanError):
            self.runner.check_schema_integrity(plan)


class WindowHashTest(RunnerBackedTest):
    """两个匿名窗口的输入 SHA 必须与提案登记值一致。"""

    def test_recorded_window_hashes_match_the_proposal(self) -> None:
        plan = _plan()
        self.assertEqual(
            [window["input_sha256"] for window in plan["windows"]],
            [
                "6f873ef4ac1f6c8952a034c0ca98c5ccd25454b13dd445f07d72577c608dbcc5",
                "0b1549bd53b73ef4c033b46357d76f75f5d74eca7d7bd174a467b2e90c56d512",
            ],
        )
        self.assertEqual(
            [window["window_id"] for window in plan["windows"]], ["W1", "W2"]
        )

    def test_input_paths_stay_outside_the_repository(self) -> None:
        for window in _plan()["windows"]:
            self.assertFalse(
                Path(window["input_path"]).expanduser().is_relative_to(REPO),
                f"{window['input_path']} 不应位于仓库内",
            )


class PhaseOneGateTest(RunnerBackedTest):
    """阶段 1 的 G1-a／G1-b／G1-c 逐门判定。"""

    def test_clean_phase_one_passes_all_three_gates(self) -> None:
        records = _all_supported()
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertTrue(result["passed"])
        self.assertTrue(result["checks"]["G1-a"]["passed"])
        self.assertTrue(result["checks"]["G1-b"]["passed"])
        self.assertTrue(result["checks"]["G1-c"]["passed"])

    def test_g1a_fails_on_an_empty_return(self) -> None:
        records = _all_supported()
        _override(records, 1, structural_valid=False, empty_return=True, verdict=None, issues=[])
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertFalse(result["checks"]["G1-a"]["passed"])
        self.assertFalse(result["passed"])

    def test_g1a_fails_when_a_position_was_not_run(self) -> None:
        records = _all_supported()
        _override(records, 7, invoked=False, not_run=True, structural_valid=False, verdict=None, issues=[])
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertFalse(result["checks"]["G1-a"]["passed"])

    def test_g1a_fails_on_a_protocol_failure(self) -> None:
        records = _all_supported()
        _override(records, 3, structural_valid=False, protocol_failure=True, failure="RuntimeError", verdict=None, issues=[])
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertFalse(result["checks"]["G1-a"]["passed"])

    def test_g1b_fails_on_a_bad_auto(self) -> None:
        records = _all_supported()
        _override(records, 6, bad_auto=True, field_fidelity=False)
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertTrue(result["checks"]["G1-a"]["passed"])
        self.assertFalse(result["checks"]["G1-b"]["passed"])
        self.assertFalse(result["passed"])

    def test_g1b_fails_on_a_hard_reject(self) -> None:
        records = _records(1, {
            "baseline": [("supported", [])] * 4,
            "candidate": [("unsupported", ["subject"])] * 4,
        })
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertFalse(result["checks"]["G1-b"]["passed"])
        self.assertFalse(result["passed"])

    def test_g1c_passes_when_candidate_matches_baseline(self) -> None:
        records = _records(1, {
            "baseline": [("uncertain", ["pragmatics"])] + [("supported", [])] * 3,
            "candidate": [("uncertain", ["pragmatics"])] + [("supported", [])] * 3,
        })
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertEqual(result["downgrades"], {"baseline": 1, "candidate": 1})
        self.assertTrue(result["checks"]["G1-c"]["passed"])
        self.assertTrue(result["passed"])

    def test_g1c_passes_when_candidate_is_below_baseline(self) -> None:
        records = _records(1, {
            "baseline": [("uncertain", ["pragmatics"])] * 2 + [("supported", [])] * 2,
            "candidate": [("uncertain", ["pragmatics"])] + [("supported", [])] * 3,
        })
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertEqual(result["downgrades"], {"baseline": 2, "candidate": 1})
        self.assertTrue(result["checks"]["G1-c"]["passed"])
        self.assertTrue(result["passed"])

    def test_g1c_fails_when_the_candidate_cap_is_exceeded(self) -> None:
        records = _records(1, {
            "baseline": [("uncertain", ["pragmatics"])] * 3 + [("supported", [])],
            "candidate": [("uncertain", ["pragmatics"])] * 2 + [("supported", [])] * 2,
        })
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertEqual(result["downgrades"], {"baseline": 3, "candidate": 2})
        self.assertFalse(result["checks"]["G1-c"]["passed"])
        self.assertFalse(result["passed"])

    def test_g1c_fails_when_candidate_has_two_downgrades_against_zero(self) -> None:
        records = _records(1, {
            "baseline": [("supported", [])] * 4,
            "candidate": [("uncertain", ["pragmatics"])] * 2 + [("supported", [])] * 2,
        })
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertTrue(result["checks"]["G1-b"]["passed"])
        self.assertFalse(result["checks"]["G1-c"]["passed"])
        self.assertFalse(result["passed"])

    def test_supported_with_non_empty_issues_counts_as_downgrade(self) -> None:
        records = _records(1, {
            "baseline": [("supported", [])] * 4,
            "candidate": [("supported", ["time"])] + [("supported", [])] * 3,
        })
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertEqual(result["downgrades"]["candidate"], 1)


class PhaseTwoGateTest(RunnerBackedTest):
    """阶段 2 的安全门、运行门与主判定三分支。"""

    def test_all_three_gates_pass_together_on_a_clean_run(self) -> None:
        result = self.runner.evaluate_phase2_gates(
            _plan(), _balanced_phase2(candidate_repeats=0, baseline_repeats=2)
        )
        self.assertTrue(result["safety_gate"]["passed"])
        self.assertTrue(result["runtime_gate"]["passed"])
        self.assertEqual(result["main_judgment"]["branch"], "benefit")
        self.assertTrue(result["passed"])

    def test_safety_gate_fails_on_a_bad_auto(self) -> None:
        records = _balanced_phase2(candidate_repeats=0, baseline_repeats=0)
        _override(records, 9, bad_auto=True, field_fidelity=False)
        result = self.runner.evaluate_phase2_gates(_plan(), records)
        self.assertFalse(result["safety_gate"]["passed"])
        self.assertFalse(result["passed"])
        self.assertEqual(result["main_judgment"]["branch"], "no_observable_signal")

    def test_safety_gate_fails_on_a_hard_reject(self) -> None:
        records = _balanced_phase2(candidate_repeats=0, baseline_repeats=0)
        _override(records, 11, verdict="unsupported", issues=["subject"], hard_reject=True, bad_auto=False)
        result = self.runner.evaluate_phase2_gates(_plan(), records)
        self.assertFalse(result["safety_gate"]["passed"])
        self.assertEqual(result["hard_rejects"]["candidate"], 1)

    def test_safety_gate_fails_when_a_candidate_leaves_pending(self) -> None:
        records = _balanced_phase2(candidate_repeats=0, baseline_repeats=0)
        _override(records, 16, stays_pending=False, field_fidelity=True)
        result = self.runner.evaluate_phase2_gates(_plan(), records)
        self.assertFalse(result["safety_gate"]["passed"])
        self.assertEqual(result["pending_positions"], 15)

    def test_runtime_gate_fails_when_an_arm_exceeds_one_failure(self) -> None:
        records = _balanced_phase2(candidate_repeats=0, baseline_repeats=0)
        _override(records, 9, structural_valid=False, empty_return=True, verdict=None, issues=[], bad_auto=False)
        _override(records, 12, invoked=False, not_run=True, structural_valid=False, verdict=None, issues=[], bad_auto=False)
        result = self.runner.evaluate_phase2_gates(_plan(), records)
        self.assertFalse(result["runtime_gate"]["passed"])
        self.assertEqual(result["runtime_gate"]["status"], "证据不足")
        self.assertEqual(
            result["runtime_gate"]["failures_or_empty"]["baseline"], 2
        )

    def test_runtime_gate_one_failure_stays_in_bound_but_requires_all_sixteen(
        self,
    ) -> None:
        """单臂 1 次失败仍在容忍上限内，但 16/16 结构合法不满足，仍判“证据不足”。"""

        records = _balanced_phase2(candidate_repeats=0, baseline_repeats=0)
        _override(records, 9, structural_valid=False, empty_return=True,
                  verdict=None, issues=[], bad_auto=False)
        result = self.runner.evaluate_phase2_gates(_plan(), records)
        self.assertEqual(
            result["runtime_gate"]["failures_or_empty"]["baseline"], 1
        )
        self.assertLessEqual(
            result["runtime_gate"]["failures_or_empty"]["baseline"],
            result["runtime_gate"]["per_arm_failures_or_empty_max"],
        )
        self.assertEqual(result["runtime_gate"]["structurally_valid"], 15)
        self.assertFalse(result["runtime_gate"]["passed"])
        self.assertEqual(result["runtime_gate"]["status"], "证据不足")
        # 失败位置照计分母：每臂分母仍是 8，不补位。
        self.assertEqual(result["denominator"], {"baseline": 8, "candidate": 8})

    def test_runtime_gate_passes_when_all_sixteen_are_structurally_valid(
        self,
    ) -> None:
        result = self.runner.evaluate_phase2_gates(
            _plan(), _balanced_phase2(candidate_repeats=0, baseline_repeats=0)
        )
        self.assertEqual(result["runtime_gate"]["structurally_valid"], 16)
        self.assertEqual(
            result["runtime_gate"]["failures_or_empty"],
            {"baseline": 0, "candidate": 0},
        )
        self.assertTrue(result["runtime_gate"]["passed"])

    def test_main_judgment_no_difference(self) -> None:
        result = self.runner.evaluate_phase2_gates(
            _plan(), _balanced_phase2(candidate_repeats=2, baseline_repeats=2)
        )
        self.assertEqual(result["main_judgment"]["branch"], "no_difference")
        self.assertTrue(result["passed"])

    def test_main_judgment_harmful(self) -> None:
        result = self.runner.evaluate_phase2_gates(
            _plan(), _balanced_phase2(candidate_repeats=3, baseline_repeats=1)
        )
        self.assertEqual(result["main_judgment"]["branch"], "harmful")
        self.assertTrue(result["passed"])

    def test_main_judgment_zero_and_zero_is_not_a_benefit(self) -> None:
        result = self.runner.evaluate_phase2_gates(
            _plan(), _balanced_phase2(candidate_repeats=0, baseline_repeats=0)
        )
        self.assertEqual(
            result["main_judgment"]["branch"], "no_observable_signal"
        )
        self.assertTrue(result["passed"])


class DenominatorAndNoBackfillTest(RunnerBackedTest):
    """失败与空返回照计分母，且不重跑、不补位。"""

    def test_denominator_stays_eight_per_arm_with_failures(self) -> None:
        records = _all_supported()
        _override(records, 1, structural_valid=False, empty_return=True, verdict=None, issues=[])
        _override(records, 2, invoked=False, not_run=True, structural_valid=False, verdict=None, issues=[])
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertEqual(result["denominator"], {"baseline": 4, "candidate": 4})

    def test_missing_position_is_counted_as_not_run_instead_of_backfilled(
        self,
    ) -> None:
        records = _all_supported()[:-1]
        normalized = self.runner.normalize_records(records, plan=_plan(), phase=1)
        self.assertEqual(len(normalized), 8)
        missing = [record for record in normalized if record["not_run"]]
        self.assertEqual(len(missing), 1)
        self.assertFalse(missing[0]["structural_valid"])
        result = self.runner.evaluate_phase1_gates(_plan(), records)
        self.assertFalse(result["checks"]["G1-a"]["passed"])

    def test_a_slot_is_never_invoked_twice_in_the_plan(self) -> None:
        sequences = [
            (entry["slot_id"], entry["arm"])
            for entry in _plan()["schedule"]["invocations"]
        ]
        self.assertEqual(len(sequences), len(set(sequences)))
        self.assertEqual(len(_plan()["schedule"]["invocations"]), 16)


class PhaseOneDefeatClosesPhaseTwoTest(RunnerBackedTest):
    """阶段 1 判败即永久关闭阶段 2。"""

    def test_phase_two_is_permanently_closed_when_phase_one_fails(self) -> None:
        records = _records(1, {
            "baseline": [("supported", [])] * 4,
            "candidate": [("uncertain", ["pragmatics"])] * 2 + [("supported", [])] * 2,
        })
        outcome = self.runner.phase1_defeat_outcome(_plan(), records)
        self.assertTrue(outcome["phase1_failed"])
        self.assertEqual(outcome["phase2_status"], "permanently-closed")
        self.assertEqual(outcome["invokes_used"], 8)
        self.assertEqual(outcome["invokes_closed_unused"], 8)
        self.assertTrue(outcome["budget_closed"])
        self.assertTrue(outcome["no_retry_or_rerun"])

    def test_phase_two_stays_open_when_phase_one_passes(self) -> None:
        records = _all_supported()
        outcome = self.runner.phase1_defeat_outcome(_plan(), records)
        self.assertFalse(outcome["phase1_failed"])
        self.assertEqual(outcome["phase2_status"], "open")
        self.assertEqual(outcome["invokes_used"], 8)


class BudgetCountTest(RunnerBackedTest):
    """预算上限 16 与 E／V／R 拆分不得被运行路径绕过。"""

    def test_plan_budget_is_sixteen_with_e_zero_and_r_zero(self) -> None:
        plan = _plan()
        self.assertEqual(plan["budget"]["max_public_invokes"], 16)
        self.assertEqual(plan["budget"]["phase1_invokes"], 8)
        self.assertEqual(plan["budget"]["phase2_invokes"], 8)
        self.assertEqual(plan["budget"]["E"], 0)
        self.assertEqual(plan["budget"]["V"], 16)
        self.assertEqual(plan["budget"]["R"], 0)

    def test_planned_invokes_fit_the_budget_exactly(self) -> None:
        plan = _plan()
        self.assertEqual(
            len(plan["schedule"]["invocations"]),
            plan["budget"]["max_public_invokes"],
        )
        self.assertEqual(
            self.runner.budget_summary(plan)["planned_public_invokes"], 16
        )

    def test_runner_refuses_to_invoke_beyond_the_budget(self) -> None:
        plan = _plan()
        self.assertEqual(self.runner.budget_summary(plan)["remaining"], 16)
        with self.assertRaises(self.runner.PlanError):
            self.runner.assert_within_budget(plan, attempted_invokes=17)


class DryRunCredentialTest(RunnerBackedTest):
    """dry-run 必须在读凭据之前返回，且不写任何真实运行记录。"""

    def test_dry_run_never_reads_credentials(self) -> None:
        runtime_config = importlib.import_module("notalone.runtime_config")
        adapter = importlib.import_module(
            "notalone.reply.adapters.deepseek_provider"
        )
        output_root = Path(tempfile.mkdtemp(prefix="notalone-v2-dry-run-"))
        stdout = io.StringIO()
        with mock.patch.object(
            runtime_config, "load_project_env",
            side_effect=AssertionError("dry-run 不得读取 .env"),
        ), mock.patch.object(
            adapter, "build_deepseek_model",
            side_effect=AssertionError("dry-run 不得构造模型客户端"),
        ), mock.patch.object(
            self.runner, "_load_runtime_model",
            side_effect=AssertionError("dry-run 不得构造模型客户端"),
        ), mock.patch.object(
            self.runner, "_api_key_fingerprint",
            side_effect=AssertionError("dry-run 不得读取凭据"),
        ), contextlib.redirect_stdout(stdout):
            code = self.runner.main(["--dry-run", "--output", str(output_root)])
        self.assertEqual(code, 0)
        printed = stdout.getvalue()
        self.assertIn("DRY-RUN", printed)
        self.assertIn("16", printed)
        record = json.loads(
            (output_root / "dry-run-v2.json").read_text(encoding="utf-8")
        )
        self.assertTrue(record["dry_run"])
        self.assertEqual(record["invokes_planned"], 16)
        self.assertEqual(record["invokes_executed"], 0)
        self.assertIsNone(record["credentials_read"])
        self.assertEqual(len(record["positions"]), 16)

    def test_dry_run_writes_no_raw_response_or_budget_reservation(self) -> None:
        output_root = Path(tempfile.mkdtemp(prefix="notalone-v2-dry-run-"))
        with contextlib.redirect_stdout(io.StringIO()):
            self.runner.main(["--dry-run", "--output", str(output_root)])
        names = sorted(path.name for path in output_root.iterdir())
        self.assertNotIn("budget-reservation-v2.json", names)
        self.assertNotIn("close-v2.json", names)
        self.assertFalse([name for name in names if name.endswith("-V-response.json")])

    def test_dry_run_prints_the_sixteen_positions_in_order(self) -> None:
        output_root = Path(tempfile.mkdtemp(prefix="notalone-v2-dry-run-"))
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.runner.main(["--dry-run", "--output", str(output_root)])
        record = json.loads(
            (output_root / "dry-run-v2.json").read_text(encoding="utf-8")
        )
        positions = record["positions"]
        self.assertEqual([entry["sequence"] for entry in positions],
                         list(range(1, 17)))
        self.assertEqual(
            [(entry["window_id"], entry["repeat"]) for entry in positions[:2]],
            [("W1", "r1"), ("W1", "r1")],
        )
        self.assertEqual(
            [entry["arm"] for entry in positions[:4]],
            ["baseline", "candidate", "candidate", "baseline"],
        )
        printed = stdout.getvalue()
        self.assertIn("baseline", printed)
        self.assertIn("candidate", printed)

    def test_dry_run_verifies_the_run_source_and_schema_hashes(self) -> None:
        """dry-run 记录里必须出现源码与 schema 校验结果，且与计划登记值一致。"""

        plan = _plan()
        output_root = Path(tempfile.mkdtemp(prefix="notalone-v2-dry-run-"))
        with contextlib.redirect_stdout(io.StringIO()):
            code = self.runner.main(["--dry-run", "--output", str(output_root)])
        self.assertEqual(code, 0)
        record = json.loads(
            (output_root / "dry-run-v2.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            record["source_integrity"]["runner_script_sha256"],
            plan["sources"]["runner_script_sha256"],
        )
        self.assertEqual(
            record["source_integrity"]["prepare_script_sha256"],
            plan["sources"]["prepare_script_sha256"],
        )
        self.assertEqual(
            record["schema_integrity"], plan["sources"]["schema_sha256"]
        )

    def test_credential_read_only_happens_after_the_dry_run_return(self) -> None:
        source = RUNNER_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        main = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "main"
        )
        lines = source.splitlines()
        dry_guard = next(
            node for node in ast.walk(main)
            if isinstance(node, ast.If) and "dry_run" in ast.dump(node.test)
            and any(isinstance(child, ast.Return) for child in node.body)
        )
        dry_return = next(
            child.lineno for child in dry_guard.body
            if isinstance(child, ast.Return)
        )
        credential_lines = [
            node.lineno for node in ast.walk(main)
            if isinstance(node, ast.Call)
            and (
                (isinstance(node.func, ast.Name)
                 and "credential" in node.func.id.lower())
                or (isinstance(node.func, ast.Attribute)
                    and "credential" in node.func.attr.lower())
                or (isinstance(node.func, ast.Name)
                    and node.func.id == "_load_runtime_model")
                or (isinstance(node.func, ast.Attribute)
                    and node.func.attr == "load_project_env")
            )
        ]
        self.assertTrue(credential_lines, "真实运行路径必须存在凭据读取点")
        self.assertTrue(
            all(line > dry_return for line in credential_lines),
            f"凭据读取行 {credential_lines} 必须晚于 dry-run 返回行 {dry_return}",
        )
        self.assertLess(dry_return, min(credential_lines))
        self.assertIn("return", lines[dry_return - 1])
        self.assertLess(
            lines.index("    if args.dry_run:"), dry_return - 1
        )


class SyntheticCredentialBindingTest(RunnerBackedTest):
    """提案第 7.2 节「SDK 合成凭据只绑定」的仓库内记录（0 联网）。

    做法：只用自造合成 key（`SYNTHETIC_KEY`，不是任何真实凭据）构造 ECNU
    `ecnu-max` 模型，走 runner 与产品核验同一形状的 `bind_tools([schema],
    tool_choice=schema["title"])`，然后断言具名工具与 schema 绑定成功。

    **本检查不证明什么**：它不断言真实服务接受该 schema、不证明
    `tool_choice` 在 ECNU 端点可用、不产生任何模型返回，也不能当作真实调用
    可用的证据。它只证明「本地绑定路径不会在构造或绑定阶段失败」。

    网络隔离：绑定期间 `httpx.Client.send` 与 `httpx.AsyncClient.send` 都被
    patch 成抛错，任何实际出站请求都会让测试失败。
    """

    schema: dict

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        sys.path.insert(0, str(REPO / "src"))
        cls.schema = _verification_schema()
        # 断言只使用自造 key；若本机环境里存在同名变量，也不读取它。
        cls.addClassCleanup(sys.path.remove, str(REPO / "src"))

    def _model(self):
        from notalone.reply.adapters.deepseek_provider import build_deepseek_model

        return build_deepseek_model(
            api_key=SYNTHETIC_KEY,
            model_name=_plan()["scope"]["model"],
            base_url=SYNTHETIC_BASE_URL,
            extra_body={"thinking": {"type": "enabled"}},
        )

    @staticmethod
    def _network_guard():
        import httpx

        return (
            mock.patch.object(
                httpx.Client, "send",
                side_effect=AssertionError("只绑定检查不得发起同步请求"),
            ),
            mock.patch.object(
                httpx.AsyncClient, "send",
                side_effect=AssertionError("只绑定检查不得发起异步请求"),
            ),
        )

    def test_synthetic_key_binds_the_named_tool_and_schema(self) -> None:
        sync_guard, async_guard = self._network_guard()
        with sync_guard, async_guard:
            model = self._model()
            bound = model.bind_tools(
                [self.schema], tool_choice=self.schema["title"]
            )
            tools = bound.kwargs["tools"]
            self.assertEqual(len(tools), 1)
            self.assertEqual(tools[0]["function"]["name"], self.schema["title"])
            self.assertEqual(
                tools[0]["function"]["name"], "SourceVerificationOutput"
            )
            self.assertEqual(
                tools[0]["function"]["parameters"]["required"], ["results"]
            )
            self.assertEqual(
                bound.kwargs["tool_choice"]["function"]["name"],
                self.schema["title"],
            )
            self.assertIsNotNone(getattr(bound, "invoke", None))

    def test_synthetic_key_never_resolves_credentials_from_the_environment(
        self,
    ) -> None:
        """即使环境里有同名变量，也只使用自造 key；不读 `.env`。"""

        runtime_config = importlib.import_module("notalone.runtime_config")
        sync_guard, async_guard = self._network_guard()
        with mock.patch.dict(
            os.environ, {"NOTALONE_DEEPSEEK_API_KEY": "sk-should-not-be-read"},
        ), mock.patch.object(
            runtime_config, "load_project_env",
            side_effect=AssertionError("只绑定检查不得读取 .env"),
        ), sync_guard, async_guard:
            model = self._model()
            bound = model.bind_tools([self.schema], tool_choice="ignored")
            self.assertEqual(
                bound.kwargs["tools"][0]["function"]["name"],
                self.schema["title"],
            )

    def test_runner_binding_path_uses_the_same_named_tool_shape(self) -> None:
        """runner 的 `_invoke` 与产品核验共用同一具名工具绑定形状。"""

        source = RUNNER_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        invoke = next(
            node for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == "_invoke"
        )
        tool_choices = [
            node for node in ast.walk(invoke)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "bind_tools"
        ]
        self.assertTrue(tool_choices, "_invoke 必须调用 bind_tools")
        self.assertTrue(
            any(
                keyword.arg == "tool_choice" for keyword in tool_choices[0].keywords
            ),
            "首次绑定必须显式钉扎 tool_choice",
        )
        product_source = VERIFICATION_ADAPTERS.read_text(encoding="utf-8")
        self.assertIn("tool_choice=SOURCE_VERIFICATION_SCHEMA[\"title\"]",
                      product_source)


class RunnerSourceBoundaryTest(RunnerBackedTest):
    """runner 与计划不得读真实聊天、留出或业务数据。"""

    def test_runner_does_not_reference_holdout_or_real_chat_paths(self) -> None:
        """留出／真实聊天的字眼只允许出现在说明性文档字符串里，不能出现在可执行代码。"""

        source = RUNNER_PATH.read_text(encoding="utf-8")
        tree = ast.parse(source)
        docstrings: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)):
                doc = ast.get_docstring(node)
                if doc:
                    docstrings.append(doc)
        code_lines = [
            line for line in source.splitlines()
            if not line.lstrip().startswith("#")
        ]
        executable = "\n".join(code_lines)
        for doc in docstrings:
            executable = executable.replace(doc, "")
        for forbidden in ("chat_exports", "/actual/", "/held/", "holdout/"):
            self.assertNotIn(forbidden, executable)
        self.assertIn("不读真实聊天", ast.get_docstring(tree) or "")

    def test_plan_forbids_holdout_and_official_endpoint(self) -> None:
        plan = _plan()
        self.assertFalse(plan["boundaries"]["reads_real_chat"])
        self.assertFalse(plan["boundaries"]["reads_actual_or_held_holdout"])
        self.assertFalse(plan["scope"]["official_deepseek_endpoint_or_key"])
        self.assertEqual(plan["scope"]["model"], "ecnu-max")
        self.assertEqual(plan["scope"]["fallback_provider"], "none")
        self.assertIn("chat.ecnu.edu.cn", plan["scope"]["provider"])

    def test_plan_records_the_not_doing_list_and_private_output(self) -> None:
        plan = _plan()
        self.assertGreaterEqual(len(plan["not_doing"]), 7)
        self.assertEqual(
            plan["isolation"]["private_output_dir"],
            "~/.notalone/audits/memory-claim-retention-repetition-20261005",
        )
        self.assertEqual(plan["isolation"]["private_dir_mode"], "0700")
        self.assertEqual(plan["isolation"]["private_file_mode"], "0600")
        self.assertFalse(plan["isolation"]["in_git"])


RUNNER_DEPENDENT_TEST_CLASSES = (
    "FrozenPlanV2Test",
    "ScheduleRotationTest",
    "ArmPromptHashTest",
    "SourceHashIntegrityTest",
    "SchemaHashNormalizationTest",
    "WindowHashTest",
    "PhaseOneGateTest",
    "PhaseTwoGateTest",
    "DenominatorAndNoBackfillTest",
    "PhaseOneDefeatClosesPhaseTwoTest",
    "BudgetCountTest",
    "DryRunCredentialTest",
    "SyntheticCredentialBindingTest",
    "RunnerSourceBoundaryTest",
)

# 在类创建之后按当前文件状态挂 skipUnless：unittest 会先看类的 __unittest_skip__
# 再决定是否调用 setUpClass，因此脚本缺失时这些类记为 skipped 而不是 error。
RUNNER_AVAILABLE = RUNNER_PATH.is_file()
RUNNER_MISSING_SKIP_REASON = f"缺少 runner 脚本，跳过：{RUNNER_PATH}"
for _class_name in RUNNER_DEPENDENT_TEST_CLASSES:
    _guarded_class = unittest.skipUnless(
        RUNNER_AVAILABLE, RUNNER_MISSING_SKIP_REASON
    )(globals()[_class_name])
    globals()[_class_name] = _guarded_class
del _class_name, _guarded_class


class RunnerMissingScriptSkipProofTest(unittest.TestCase):
    """证明「脚本缺失 → 跳过而非报错」；本类自身不加载 runner。

    做法不移动、不删除仓库里的脚本：`_temp_repo_copy` 把本测试模块复制到
    一个结构与仓库同构、但没有 `.scratch/` runner 的临时目录，然后在子进程里
    用 importlib 加载这个复制件，直接检查守卫状态。真实仓库在整个测试期间
    保持原样，其他并行任务不会观察到脚本消失。

    覆盖：缺失时模块仍能 import（收集阶段不读 `.scratch/`）、runner 没有被
    加载、14 个依赖 runner 的测试类都带 `unittest.skipUnless` 跳过标记与跳过
    原因、证明类自身没有跳过标记（缺失时必须真的运行）。
    真实 `unittest discover` 在脚本被移走时的行为已按同一路径人工实测：
    67 个位置全部 skipped、0 error（见本轮验证记录）。
    """

    def test_missing_runner_script_marks_every_guarded_class_as_skipped(self) -> None:
        with _temp_repo_copy(include_runner=False) as copied:
            self.assertFalse(copied.runner_path.exists())
            state = _inspect_guard_in_subprocess(copied)
        self.assertEqual(state["runner_available"], False)
        self.assertEqual(state["runner_path_exists"], False)
        self.assertEqual(
            state["guarded_classes"],
            sorted(RUNNER_DEPENDENT_TEST_CLASSES),
            "缺失时必须仍能收集全部依赖 runner 的测试类",
        )
        self.assertTrue(
            all("缺少 runner 脚本" in reason for reason in state["reason"].values()),
            state["reason"],
        )
        self.assertTrue(
            all(state["skip_flag"].values()),
            f"每个依赖 runner 的类都必须带跳过标记：{state['skip_flag']}",
        )
        self.assertFalse(state["proof_class_skipped"],
                         "证明类自身不得被跳过，否则缺失时会静默通过")
        self.assertFalse(state["runner_loaded"])
        self.assertEqual(state["proof_class_tests"], _class_test_count(
            "RunnerMissingScriptSkipProofTest"
        ))

    def test_the_guard_stays_off_when_the_script_exists(self) -> None:
        """同样的检查在脚本存在时必须给出相反结果，证明守卫不是恒真。"""

        if not RUNNER_PATH.is_file():
            # 建立“存在”场景需要仓库里的脚本确实存在；缺失时本测试跳过，
            # 而证明“缺失 → 跳过”的两条测试仍然运行。
            self.skipTest(f"缺少 runner 脚本，无法建立存在场景：{RUNNER_PATH}")
        with _temp_repo_copy(include_runner=True) as copied:
            self.assertTrue(copied.runner_path.is_file())
            state = _inspect_guard_in_subprocess(copied)
        self.assertEqual(state["runner_available"], True)
        self.assertEqual(state["runner_path_exists"], True)
        self.assertEqual(state["guarded_classes"], sorted(RUNNER_DEPENDENT_TEST_CLASSES))
        self.assertFalse(any(state["skip_flag"].values()), state["skip_flag"])

    def test_importing_this_module_does_not_load_the_runner(self) -> None:
        """收集阶段不得读 `.scratch/`；runner 缺失也必须能被 import。"""

        with _temp_repo_copy(include_runner=False) as copied:
            state = _inspect_guard_in_subprocess(copied)
        self.assertTrue(state["imported"])
        self.assertFalse(state["runner_loaded"])
        self.assertNotIn("run_comparison_v2", sys.modules)


_IMPORT_PROBE_SOURCE = '''
"""在临时仓库副本里 import 测试模块，只检查守卫状态，不运行测试。"""

import importlib.util
import json
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo))

spec = importlib.util.spec_from_file_location("pool_import_probe", Path({module_path!r}))
module = importlib.util.module_from_spec(spec)
sys.modules["pool_import_probe"] = module
spec.loader.exec_module(module)

guarded = {{}}
skip_flag = {{}}
reason = {{}}
for class_name in module.RUNNER_DEPENDENT_TEST_CLASSES:
    klass = getattr(module, class_name)
    guarded[class_name] = True
    skip_flag[class_name] = bool(getattr(klass, "__unittest_skip__", False))
    reason[class_name] = str(getattr(klass, "__unittest_skip_why__", ""))

proof = module.RunnerMissingScriptSkipProofTest
print("PROBE-RESULT " + json.dumps({{
    "imported": True,
    "runner_available": bool(module.RUNNER_AVAILABLE),
    "runner_path_exists": module.RUNNER_PATH.exists(),
    "runner_path": str(module.RUNNER_PATH),
    "guarded_classes": sorted(guarded),
    "skip_flag": skip_flag,
    "reason": reason,
    "proof_class_skipped": bool(getattr(proof, "__unittest_skip__", False)),
    "proof_class_tests": sum(
        1 for name in dir(proof) if name.startswith("test")
    ),
    "runner_loaded": "run_comparison_v2" in sys.modules,
}}, ensure_ascii=False))
'''


def _plan_relative(recorded: str) -> Path:
    """把计划里记录的仓库相对路径解析到本计划所在的仓库（副本）根。"""

    # PLAN_PATH.parents[3] 是 V2_DIR 所归属的仓库根：本模块与复制件同构，
    # 因此同一表达式在临时副本里也会解析到副本根。
    return PLAN_PATH.parents[3] / recorded


def _write_copy_plan(v2_dir: Path, repo: Path) -> None:
    """把冻结计划复制进副本，并把运行源码路径与 SHA 改写为副本内的真实值。"""

    plan = json.loads(PLAN_PATH.read_text(encoding="utf-8"))
    runner_copy = v2_dir / RUNNER_PATH.name
    prepare_copy = v2_dir / PREPARE_PATH.name
    plan["sources"]["runner_script"] = str(runner_copy.relative_to(repo))
    plan["sources"]["prepare_script"] = str(prepare_copy.relative_to(repo))
    plan["sources"]["prepare_script_sha256"] = _sha256_file(prepare_copy)
    plan["sources"]["runner_script_sha256"] = (
        _sha256_file(runner_copy) if runner_copy.is_file() else "0" * 64
    )
    (v2_dir / PLAN_PATH.name).write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )


class _TempRepoCopy:
    """临时仓库副本：复制件自身的路径解析出独立（无 runner）的 `RUNNER_PATH`。

    副本用 `gitdir` 文件指向真实仓库的 `.git`，因此需要 git 的测试（基线提示、
    源码哈希）在“脚本存在”场景下仍然可运行；真实仓库全程不被修改。
    """

    def __init__(self, repo: Path, module: Path, v2_dir: Path) -> None:
        self.repo = repo
        self.module = module
        self.v2_dir = v2_dir

    @property
    def runner_path(self) -> Path:
        return self.v2_dir / RUNNER_PATH.name

    @property
    def prepare_path(self) -> Path:
        return self.v2_dir / PREPARE_PATH.name

    @property
    def plan_path(self) -> Path:
        return self.v2_dir / PLAN_PATH.name


@contextlib.contextmanager
def _temp_repo_copy(*, include_runner: bool):
    """复制本测试模块到临时目录，得到与仓库同构、可选的带 runner 的副本。"""

    with tempfile.TemporaryDirectory(prefix="notalone-v2-repo-copy-") as tmp:
        repo = Path(tmp)
        module = repo / "tests" / "unit" / "experiments" / Path(__file__).name
        module.parent.mkdir(parents=True, exist_ok=True)
        module.write_bytes(Path(__file__).read_bytes())
        (repo / ".git").write_text(
            f"gitdir: {REPO / '.git'}\n", encoding="utf-8"
        )
        v2_dir = (
            repo / ".scratch" / "memory-core-claim-retention"
            / "product-prompt-comparison-v2"
        )
        v2_dir.mkdir(parents=True, exist_ok=True)
        # 冻结计划与 prepare 脚本始终复制：依赖 runner 的测试类在“脚本存在”
        # 场景下真的运行，需要同一份计划与运行源码；只有 runner 脚本按场景取舍。
        # 计划里的运行源码路径与 SHA 重写到副本内，保持副本自洽。
        (v2_dir / PREPARE_PATH.name).write_bytes(PREPARE_PATH.read_bytes())
        if include_runner:
            (v2_dir / RUNNER_PATH.name).write_bytes(RUNNER_PATH.read_bytes())
        _write_copy_plan(v2_dir, repo)
        yield _TempRepoCopy(repo=repo, module=module, v2_dir=v2_dir)


def _class_test_count(class_name: str) -> int:
    """某个依赖 runner 的测试类里测试方法数（unittest 的运行数）。"""

    return sum(
        1 for attribute in dir(globals()[class_name]) if attribute.startswith("test")
    )


def _inspect_guard_in_subprocess(copied: _TempRepoCopy) -> dict:
    """在子进程里 import 副本模块并回报守卫状态；不运行任何测试。"""

    probe_path = copied.module.parent / "guard_state_probe.py"
    probe_path.write_text(
        _IMPORT_PROBE_SOURCE.format(module_path=str(copied.module)),
        encoding="utf-8",
    )
    completed = subprocess.run(
        [sys.executable, "-P", str(probe_path)],
        cwd=str(copied.repo), capture_output=True, text=True, timeout=120,
        env={**os.environ, "NOTALONE_DISABLE_DOTENV": "1"},
    )
    marker = "PROBE-RESULT "
    line = next(
        (item for item in completed.stdout.splitlines() if item.startswith(marker)),
        None,
    )
    if line is None:
        raise AssertionError(
            "守卫探针没有输出结果：\n"
            f"returncode={completed.returncode}\nstdout={completed.stdout}\n"
            f"stderr={completed.stderr}"
        )
    payload = json.loads(line[len(marker):])
    if payload["runner_path_exists"] != copied.runner_path.is_file():
        raise AssertionError(f"副本 runner 状态与探针不一致：{payload}")
    return payload


def _verification_schema() -> dict:
    sys.path.insert(0, str(REPO / "src"))
    from notalone.memory_extraction.verification_adapters import (
        SOURCE_VERIFICATION_SCHEMA,
    )

    return SOURCE_VERIFICATION_SCHEMA


def _load_prepare_module() -> ModuleType:
    """从路径加载 prepare 脚本，用于核对它与 runner 的 schema SHA 一致。"""

    spec = importlib.util.spec_from_file_location(
        "prepare_comparison_v2", PREPARE_PATH
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == "__main__":
    unittest.main()

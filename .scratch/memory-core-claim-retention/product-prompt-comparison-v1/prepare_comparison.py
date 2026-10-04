"""冻结产品来源核验提示的匿名对照材料与执行计划（不调用模型）。

材料来源：匿名 C4 试点的两处旋转窗口（r1/r2 相同、r3/r4 相同），
本脚本只提取窗口、原 14 字段候选与用例标识，不读取模型输出。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

PILOT_ROOT = Path("~/.notalone/audits/memory-party-semantic-stability-pilot-20261004").expanduser()
OUTPUT = Path(".scratch/memory-core-claim-retention/product-prompt-comparison-v1")
SEED = PILOT_ROOT / "inputs-v1" / "C4-seed-original14-v1.json"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def extract_windows() -> list[dict[str, object]]:
    windows: list[dict[str, object]] = []
    seen: set[str] = set()
    for path in sorted(PILOT_ROOT.glob("trial-stage*/r*-C4-candidate/V-input.json")):
        digest = _sha256(path)
        if digest in seen:
            continue
        seen.add(digest)
        payload = _load(path)
        windows.append({
            "input_sha256": digest,
            "input_path": str(path),
            "usable": isinstance(payload, dict)
            and isinstance(payload.get("public_invoke_messages"), list),
        })
    return windows


def main() -> int:
    if not SEED.is_file():
        print(f"缺少匿名种子材料：{SEED}")
        return 1
    seed = _load(SEED)
    assert isinstance(seed, dict)
    windows = extract_windows()
    if not windows:
        print("没有找到可用的匿名旋转窗口。")
        return 1

    OUTPUT.mkdir(parents=True, exist_ok=True)
    plan = {
        "kind": "product-source-verification-prompt-comparison-v1",
        "status": "prepared-pending-credential",
        "scope": {
            "purpose": "在匿名 C4 窗口上对照产品来源核验提示与加入转述支持单叶后的候选提示。",
            "arms": [
                "baseline：当前产品 SOURCE_VERIFICATION_SYSTEM_PROMPT（改动前版本可复现）",
                "candidate：当前仓库中的产品提示（已含转述支持单叶）",
            ],
            "provider": "only existing ECNU endpoint (chat.ecnu.edu.cn/open/api/v1)",
            "model": "ecnu-max",
            "official_deepseek_endpoint_or_key": False,
            "max_public_invokes": 4,
            "per_window_invokes": 2,
            "windows": len(windows),
            "writes_to_business_data": False,
            "reads_real_chat_or_holdout": False,
        },
        "seed": {
            "path": str(SEED),
            "sha256": _sha256(SEED),
            "case_id": seed.get("case_id"),
            "fixture_origin": seed.get("fixture_origin"),
            "window_split": seed["window"].get("split"),  # type: ignore[index]
        },
        "windows": windows,
        "checks": [
            "候选正文、主体与语用字段是否与原话一致（不升级为本人事实）",
            "verdict 是否为 supported 且 issues 为空",
            "完整 Fact 是否新增 semantic:* 风险",
            "转述候选是否保持 pending（report/reported）",
            "坏 auto、误拒与不必要降级是否为 0",
        ],
        "gates": {
            "supported_all_windows": True,
            "no_semantic_risk_all_windows": True,
            "report_reported_stays_pending": True,
            "bad_auto_zero": True,
            "unnecessary_downgrade_zero": True,
        },
        "limitations": [
            "本材料只是两个匿名窗口，不证明整体提取准确率。",
            "基线提示需要从 git 取改动前版本，不能与候选提示共用同一常量。",
            "真实运行需要可用 ECNU key；当前 .env 的 key 为官方形态，不可用于 ECNU 端点。",
        ],
    }
    (OUTPUT / "frozen-plan-v1.json").write_text(
        json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    print(f"已冻结：{OUTPUT / 'frozen-plan-v1.json'}")
    print(f"窗口数：{len(windows)}；计划调用上限：{plan['scope']['max_public_invokes']}")  # type: ignore[index]
    print("输入正文留在仓库外私有目录，计划内只记录路径与哈希。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

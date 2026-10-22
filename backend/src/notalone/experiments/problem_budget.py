"""问题级总账的兼容入口；实现已提升到生产模块 `notalone.problem_budget`。

本模块只保留 `python -m notalone.experiments.problem_budget` 的 CLI 入口与旧
import 名称，供 `docs/agents/quality-diagnosis.md` 与评测脚本使用；不是产品
装配的一部分。
"""

from notalone.problem_budget import (
    ProblemBudget,
    ProblemStopped,
    check_problem_budget,
    main,
    reserve_problem_attempt,
)

__all__ = [
    "ProblemBudget",
    "ProblemStopped",
    "check_problem_budget",
    "main",
    "reserve_problem_attempt",
]


if __name__ == '__main__':
    main()

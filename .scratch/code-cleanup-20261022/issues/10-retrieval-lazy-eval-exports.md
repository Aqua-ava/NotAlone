# 10 retrieval 评测导出改为懒加载

Triage: ready-for-agent
State: resolved

## 目标

`import notalone.retrieval`（生产 `reply/context.py`、`reply/tools.py` 等使用）不再急切加载 931 行的 `retrieval/evaluation.py`；九项评测符号改为模块级 `__getattr__` 惰性导出，旧 `from notalone.retrieval import evaluate_retrieval` 用法不变。

## 证据

- `.scratch/code-audit-20261022/verify-unused.md` 第 49 行：`retrieval/__init__.py:4-16` 急切 import 评测代码，已进入生产 import 图。
- 消费点：仅 `backend/tests/unit/retrieval/test_evaluation.py`、`backend/tests/integration/persistence/test_retrieval_evaluation.py` 从包入口取评测符号；CLI `notalone-retrieval-evaluate` 直接指向 `notalone.retrieval.evaluation:main`。

## 范围

- `backend/src/notalone/retrieval/__init__.py`：保留生产符号的正常 import，评测符号改为 `_EVALUATION_EXPORTS` + `__getattr__`。
- 不改 `retrieval/evaluation.py` 本身、不解耦其余 A1 残留（见 ticket 07 Comments）。

## 验收

- 新增 `backend/tests/unit/retrieval/test_imports.py`：公开名仍可 import、未知属性仍 AttributeError、子进程验证生产导入后 `notalone.retrieval.evaluation` 不在 `sys.modules`。
- `python -m unittest discover -s tests/unit/retrieval -t .` 105 条通过；新增 3 条通过。

## Comments

- 2026-10-22 Lead 完成：`__init__.py` 评测九项符号懒加载；新增测试 3 条；`tests/unit/retrieval` 105/105 通过；子进程验证 `import notalone.server.app, notalone.reply.context, notalone.retrieval` 后 `notalone.retrieval.evaluation` 不在 `sys.modules`。
- 风险：`from notalone.retrieval import *` 会触发评测加载（全仓无此用法）；类型检查器看到的仍是 `__all__` 名单，未用 mypy。

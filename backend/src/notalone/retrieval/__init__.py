"""Retrieval Module 的公开入口。

离线评测（`notalone.retrieval.evaluation`，约 900 行）不随生产 import 加载：
它的九项公开符号通过模块级 ``__getattr__`` 惰性导出，旧的
``from notalone.retrieval import evaluate_retrieval`` 用法保持不变。
"""

from notalone.retrieval.adapters import InMemoryRetrieval
from notalone.retrieval.errors import RetrievalError, RetrievalInvariantError
from notalone.retrieval.feature_flags import RetrievalFeatureFlags
from notalone.retrieval.models import (
    RetrievedMemory,
    RetrievedMessage,
    RetrievedOwnerMemory,
    RetrievedPendingCandidate,
)
from notalone.retrieval.ports import RetrievalPort

# 只在显式访问时加载 evaluation；避免生产 `from notalone.retrieval import ...`
# 把评测代码带进启动与打包路径。
_EVALUATION_EXPORTS = frozenset({
    "EvaluationRate",
    "LatencySummary",
    "ReplyEvaluationObservation",
    "RetrievalEvaluationCase",
    "RetrievalEvaluationMetrics",
    "RetrievalEvaluationObservation",
    "RetrievalEvaluationReport",
    "SyntheticRetrievalFixture",
    "build_synthetic_retrieval_fixture",
    "evaluate_retrieval",
})

__all__ = [
    "InMemoryRetrieval",
    "EvaluationRate",
    "LatencySummary",
    "ReplyEvaluationObservation",
    "RetrievedMemory",
    "RetrievedMessage",
    "RetrievedOwnerMemory",
    "RetrievedPendingCandidate",
    "RetrievalEvaluationCase",
    "RetrievalEvaluationMetrics",
    "RetrievalEvaluationObservation",
    "RetrievalEvaluationReport",
    "RetrievalError",
    "RetrievalFeatureFlags",
    "RetrievalInvariantError",
    "RetrievalPort",
    "SyntheticRetrievalFixture",
    "build_synthetic_retrieval_fixture",
    "evaluate_retrieval",
]


def __getattr__(name: str) -> object:
    if name in _EVALUATION_EXPORTS:
        from notalone.retrieval import evaluation

        return getattr(evaluation, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

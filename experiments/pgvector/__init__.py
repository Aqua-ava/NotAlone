"""仅用于 pgvector 记忆召回隔离实验的运行时与向量导航表。"""

__all__ = [
    "CandidateVector",
    "DEFAULT_DB_NAME",
    "DEFAULT_DB_PORT",
    "DEFAULT_RUNTIME_DIR",
    "EmbeddingSpec",
    "EmbeddingUnavailableError",
    "LocalChineseEmbedder",
    "PgVectorRuntime",
    "RuntimeEvidence",
    "RuntimeUnavailableError",
    "VectorMemoryRecord",
    "VectorTable",
    "content_hash",
]


def __getattr__(name: str):
    """按需加载运行时模块，避免 ``python -m`` 提前执行模块副作用。"""

    if name in {"EmbeddingSpec", "EmbeddingUnavailableError", "LocalChineseEmbedder"}:
        from .embedding import EmbeddingSpec, EmbeddingUnavailableError, LocalChineseEmbedder

        return {
            "EmbeddingSpec": EmbeddingSpec,
            "EmbeddingUnavailableError": EmbeddingUnavailableError,
            "LocalChineseEmbedder": LocalChineseEmbedder,
        }[name]
    if name in {"CandidateVector", "VectorMemoryRecord", "VectorTable", "content_hash"}:
        from .store import CandidateVector, VectorMemoryRecord, VectorTable, content_hash

        return {
            "CandidateVector": CandidateVector,
            "VectorMemoryRecord": VectorMemoryRecord,
            "VectorTable": VectorTable,
            "content_hash": content_hash,
        }[name]
    if name in {
        "DEFAULT_DB_NAME",
        "DEFAULT_DB_PORT",
        "DEFAULT_RUNTIME_DIR",
        "PgVectorRuntime",
        "RuntimeEvidence",
        "RuntimeUnavailableError",
    }:
        from .runtime import (
            DEFAULT_DB_NAME,
            DEFAULT_DB_PORT,
            DEFAULT_RUNTIME_DIR,
            PgVectorRuntime,
            RuntimeEvidence,
            RuntimeUnavailableError,
        )

        return {
            "DEFAULT_DB_NAME": DEFAULT_DB_NAME,
            "DEFAULT_DB_PORT": DEFAULT_DB_PORT,
            "DEFAULT_RUNTIME_DIR": DEFAULT_RUNTIME_DIR,
            "PgVectorRuntime": PgVectorRuntime,
            "RuntimeEvidence": RuntimeEvidence,
            "RuntimeUnavailableError": RuntimeUnavailableError,
        }[name]
    raise AttributeError(name)

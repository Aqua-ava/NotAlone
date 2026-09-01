"""检索扩展能力的安全开关。"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass


def _environment_flag(value: str | None) -> bool:
    return isinstance(value, str) and value.strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


@dataclass(frozen=True, slots=True)
class RetrievalFeatureFlags:
    """控制尚未进入生产的检索扩展。

    向量候选路径目前没有实现。即使调用方请求开启，也必须同时提供
    隐私评审通过和已配置 provider 的显式证明；默认值保持关闭。
    """

    vector_candidates_requested: bool = False
    vector_privacy_reviewed: bool = False
    vector_provider_configured: bool = False

    def __post_init__(self) -> None:
        for name in (
            "vector_candidates_requested",
            "vector_privacy_reviewed",
            "vector_provider_configured",
        ):
            if not isinstance(getattr(self, name), bool):
                raise TypeError(f"{name} 必须是 bool。")

    @property
    def vector_candidates_enabled(self) -> bool:
        """只有请求、隐私评审和 provider 配置均成立时才允许扩展。"""

        return (
            self.vector_candidates_requested
            and self.vector_privacy_reviewed
            and self.vector_provider_configured
        )

    @classmethod
    def from_environment(
        cls,
        environ: Mapping[str, str] | None = None,
    ) -> "RetrievalFeatureFlags":
        """从环境读取开关；未设置时不改变默认的关闭状态。"""

        values = os.environ if environ is None else environ
        return cls(
            vector_candidates_requested=_environment_flag(
                values.get("NOTALONE_RETRIEVAL_VECTOR_ENABLED")
            ),
            vector_privacy_reviewed=_environment_flag(
                values.get("NOTALONE_RETRIEVAL_VECTOR_PRIVACY_REVIEWED")
            ),
            vector_provider_configured=_environment_flag(
                values.get("NOTALONE_RETRIEVAL_VECTOR_PROVIDER_CONFIGURED")
            ),
        )

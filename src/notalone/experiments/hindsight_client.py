"""仅允许 loopback 的 Hindsight 实验 HTTP 边界。"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Protocol
from urllib.parse import quote, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from notalone.scopes import ContactScope


class HindsightFailure(RuntimeError):
    """实验失败，不能作为 B 的成功空结果。"""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        raise HindsightFailure("实验 HTTP 禁止重定向。")


@dataclass(frozen=True)
class RecallHit:
    unit_id: str
    chunk_id: str | None
    document_id: str | None
    metadata: Mapping[str, str]
    reranker: float
    final: float


@dataclass(frozen=True)
class RecallBatch:
    bank_id: str
    hits: tuple[RecallHit, ...]
    rerank_complete: bool
    diagnostics: str = ""


class RecallClient(Protocol):
    def recall(self, *, bank_id: str, query: str) -> RecallBatch: ...


def bank_id_for(scope: ContactScope) -> str:
    """bank 标识仅从稳定隔离键生成，不能从备注或昵称生成。"""

    digest = hashlib.sha256(f"{scope.owner_id}:{scope.contact_id}".encode()).hexdigest()
    return "notalone-experiment-" + digest[:32]


def document_id_for(memory_id: object) -> str:
    return f"memory-{memory_id}"


class HindsightHttpClient:
    """串行实验客户端，核对同次 recall 的本机重排完成日志。"""

    def __init__(
        self,
        *,
        base_url: str,
        log_path: Path,
        timeout: float = 30.0,
        max_tokens: int = 4096,
        budget: str = "low",
        query_timestamp: str = "2026-10-04T00:00:00Z",
    ) -> None:
        parsed = urlparse(base_url)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
        ):
            raise ValueError("实验服务必须为不带凭据的本机 HTTP 地址。")
        if timeout <= 0 or max_tokens < 1 or budget not in ("low", "mid", "high"):
            raise ValueError("实验 HTTP 预算无效。")
        self.base_url = base_url.rstrip("/")
        self.log_path = log_path
        self.timeout = timeout
        self.max_tokens = max_tokens
        self.budget = budget
        self.query_timestamp = query_timestamp
        self._opener = build_opener(ProxyHandler({}), _NoRedirect())

    def request(
        self, method: str, path: str, body: dict[str, object] | None = None
    ) -> dict[str, object]:
        if not re.match(
            r"^/v1/default/banks/notalone-experiment-[a-z0-9-]+(?:/|$)", path
        ) and path not in ("/health", "/health/ready"):
            raise ValueError("实验客户端只允许 bank 和健康检查 API。")
        payload = (
            None if body is None else json.dumps(body, ensure_ascii=False).encode()
        )
        request = Request(
            self.base_url + path,
            data=payload,
            method=method,
            headers={"Content-Type": "application/json"},
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                decoded = json.loads(response.read())
        except Exception as exc:
            raise HindsightFailure(
                f"HTTP {method} 请求失败：{type(exc).__name__}"
            ) from exc
        if not isinstance(decoded, dict):
            raise HindsightFailure("Hindsight 响应结构无效。")
        return decoded

    @staticmethod
    def bank_path(bank_id: str) -> str:
        if not bank_id.startswith("notalone-experiment-"):
            raise ValueError("只能访问 NotAlone 实验 bank。")
        return "/v1/default/banks/" + quote(bank_id, safe="")

    def create_bank(self, bank_id: str) -> dict[str, object]:
        path = self.bank_path(bank_id)
        self.request("PUT", path, {"name": "NotAlone 合成实验"})
        self.request(
            "PATCH",
            path + "/config",
            {
                "updates": {
                    "retain_extraction_mode": "chunks",
                    "enable_auto_consolidation": False,
                }
            },
        )
        config = self.request("GET", path + "/config")
        return config

    def retain(
        self, *, bank_id: str, items: list[dict[str, object]]
    ) -> dict[str, object]:
        return self.request(
            "POST", self.bank_path(bank_id) + "/memories", {"items": items}
        )

    def recall(self, *, bank_id: str, query: str) -> RecallBatch:
        try:
            offset = self.log_path.stat().st_size
        except OSError as exc:
            raise HindsightFailure("缺少可核对的本机重排诊断日志。") from exc
        result = self.request(
            "POST",
            self.bank_path(bank_id) + "/memories/recall",
            {
                "query": query,
                "types": ["world"],
                "budget": self.budget,
                "max_tokens": self.max_tokens,
                "query_timestamp": self.query_timestamp,
            },
        )
        with self.log_path.open("rb") as log:
            log.seek(offset)
            diagnostics = log.read().decode("utf-8", errors="replace")
        items = result.get("results")
        if not isinstance(items, list):
            raise HindsightFailure("recall 没有结果列表。")
        # 锁定版本在 predict 成功后输出数量明确的完成日志；局部超时
        # 会额外输出警告，并把未评分项写为 0。仅字段存在不足以放行。
        finished = re.findall(
            r"\[4\] Reranking \[cross-encoder\]: (\d+) candidates scored", diagnostics
        )
        completes = re.findall(r"\[RECALL ([a-zA-Z0-9-]+)\] Complete:", diagnostics)
        if items and (
            len(finished) != 1 or len(completes) != 1 or int(finished[0]) < len(items)
        ):
            raise HindsightFailure("无法证明本次真实重排已完成。")
        if re.search(
            r"Reranking:.*(?:timeout|timed out|remainder)|RerankTimeoutError",
            diagnostics,
            re.IGNORECASE,
        ):
            raise HindsightFailure("本次重排不完整，拒绝全部候选。")
        hits = tuple(self._hit(item) for item in items)
        return RecallBatch(bank_id, hits, True, diagnostics)

    @staticmethod
    def _hit(item: object) -> RecallHit:
        if not isinstance(item, dict) or item.get("type") != "world":
            raise HindsightFailure("recall 包含非 world 或无效结果。")
        scores = item.get("scores")
        metadata = item.get("metadata")
        if (
            not isinstance(scores, dict)
            or not isinstance(metadata, dict)
            or any(
                not isinstance(k, str) or not isinstance(v, str)
                for k, v in metadata.items()
            )
        ):
            raise HindsightFailure("缺少真实分数或映射 metadata。")
        reranker, final = scores.get("reranker"), scores.get("final")
        if any(
            not isinstance(s, (float, int))
            or isinstance(s, bool)
            or not math.isfinite(s)
            for s in (reranker, final)
        ):
            raise HindsightFailure("检索分数缺失或非有限值。")
        assert isinstance(reranker, (float, int)) and isinstance(final, (float, int))
        if not 0 <= reranker <= 1:
            raise HindsightFailure("重排分数不在归一化区间。")
        return RecallHit(
            str(item.get("id", "")),
            item.get("chunk_id"),
            item.get("document_id"),
            metadata,
            float(reranker),
            float(final),
        )

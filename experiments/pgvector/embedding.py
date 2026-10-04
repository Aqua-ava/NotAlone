"""固定本地中文 embedding 边界。

模型依赖刻意采用运行时导入：生产依赖不会因为隔离实验而增加，缺少模型依赖
时会给出可记录的前提缺失错误。模型只生成导航向量，不能成为关系资料事实源。
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import importlib
import importlib.metadata
import math
from pathlib import Path
from typing import Any, Sequence


class EmbeddingUnavailableError(RuntimeError):
    """本地 embedding 前提未满足。"""


@dataclass(frozen=True)
class EmbeddingSpec:
    """本实验冻结的模型身份与输出维度。"""

    model_id: str = "BAAI/bge-small-zh-v1.5"
    model_revision: str = "7999e1d3359715c523056ef9478215996d62a620"
    dimensions: int = 512
    normalize: bool = True


class LocalChineseEmbedder:
    """在本机加载固定中文模型并输出有限的 float 向量。"""

    def __init__(
        self,
        *,
        spec: EmbeddingSpec | None = None,
        model_path: str | Path | None = None,
        device: str = "cpu",
    ) -> None:
        self.spec = spec or EmbeddingSpec()
        self.model_path = Path(model_path) if model_path is not None else None
        self.device = device
        self._model: Any | None = None
        self._package_version: str | None = None

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            module = importlib.import_module("sentence_transformers")
            sentence_transformer = module.SentenceTransformer
            self._package_version = importlib.metadata.version("sentence-transformers")
        except (ImportError, importlib.metadata.PackageNotFoundError) as exc:
            raise EmbeddingUnavailableError(
                "缺少 sentence-transformers；实验模型未加载，未执行向量写入。"
            ) from exc

        identifier = str(self.model_path or self.spec.model_id)
        # 本实验固定离线加载：显式本地路径和模型 ID 都不允许网络回退。
        kwargs: dict[str, Any] = {"device": self.device, "local_files_only": True}
        try:
            self._model = sentence_transformer(identifier, **kwargs)
        except TypeError:
            # 旧 API 不识别该关键字；只有明确本地路径时才继续，避免隐式联网。
            if self.model_path is None:
                raise EmbeddingUnavailableError(
                    "当前 sentence-transformers 不支持离线加载参数，拒绝联网加载模型。"
                )
            self._model = sentence_transformer(identifier, device=self.device)
        except Exception as exc:  # noqa: BLE001 - 将前提失败统一为可记录错误
            raise EmbeddingUnavailableError(
                f"无法从本地路径加载 embedding 模型：{identifier}"
            ) from exc
        return self._model

    def encode(self, texts: str | Sequence[str]) -> tuple[tuple[float, ...], ...]:
        """将一条或多条文字编码为固定 512 维、可存入 pgvector 的向量。"""

        values = [texts] if isinstance(texts, str) else list(texts)
        if not values:
            return ()
        if any(not isinstance(value, str) for value in values):
            raise TypeError("embedding 输入必须是文字序列")
        model = self._load()
        result = model.encode(
            values,
            normalize_embeddings=self.spec.normalize,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        rows = result.tolist() if hasattr(result, "tolist") else list(result)
        if len(rows) != len(values):
            raise EmbeddingUnavailableError("embedding 返回行数与输入不一致")
        normalized: list[tuple[float, ...]] = []
        for row in rows:
            vector = tuple(float(number) for number in row)
            if len(vector) != self.spec.dimensions:
                raise EmbeddingUnavailableError(
                    f"模型维度为 {len(vector)}，预期 {self.spec.dimensions}"
                )
            if not all(math.isfinite(number) for number in vector):
                raise EmbeddingUnavailableError("embedding 含非有限数值")
            normalized.append(vector)
        return tuple(normalized)

    def summary(self) -> dict[str, Any]:
        """返回可写入实验 manifest 的模型摘要，不包含正文。"""

        return {
            "model_id": self.spec.model_id,
            "model_revision": self.spec.model_revision,
            "dimensions": self.spec.dimensions,
            "normalize": self.spec.normalize,
            "device": self.device,
            "model_path": str(self.model_path) if self.model_path else None,
            "sentence_transformers_version": self._package_version,
        }


def model_path_sha256(path: str | Path) -> str:
    """对本地模型文件树做稳定摘要，便于记录实际模型副本。"""

    root = Path(path)
    if not root.exists():
        raise FileNotFoundError(root)
    digest = hashlib.sha256()
    files = sorted(file for file in root.rglob("*") if file.is_file())
    for file in files:
        digest.update(str(file.relative_to(root)).encode("utf-8"))
        digest.update(b"\0")
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()

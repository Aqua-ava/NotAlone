"""本机临时 PostgreSQL＋pgvector 运行入口。

运行时只允许操作本实验命名的 pg0 实例、数据库目录和 manifest。它不读取
NotAlone 配置，也不接受业务数据库 URL，避免隔离实验意外触碰正式资料。
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import importlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .embedding import EmbeddingSpec
from .store import VectorTable


DEFAULT_RUNTIME_DIR = Path("/tmp/notalone-pgvector-memory-recall")
DEFAULT_DB_NAME = "notalone-pgvector-memory-recall"
DEFAULT_DB_PORT = 18553
# 只用 loopback 和临时 pg0 的默认身份；库名与端口已由 _validate_identity 约束。
DEFAULT_DB_ROLE = "postgres"
DEFAULT_DB_PASSWORD = "postgres"
DEFAULT_DB_URL = (
    f"postgresql://{DEFAULT_DB_ROLE}:{DEFAULT_DB_PASSWORD}"
    f"@127.0.0.1:{DEFAULT_DB_PORT}/postgres"
)
MANIFEST_NAME = "runtime-manifest.json"


def redacted_db_url(url: str) -> str:
    """去掉用户信息，保证证据里不落任何口令。"""

    parts = urlsplit(url)
    if not parts.netloc or "@" not in parts.netloc:
        return url
    host = parts.netloc.rsplit("@", 1)[1]
    return urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))


class RuntimeUnavailableError(RuntimeError):
    """临时数据库或 vector 扩展前提不满足。"""


@dataclass(frozen=True)
class RuntimeEvidence:
    """可写入报告的运行时证据；连接串只保留不含凭据的形式。"""

    runtime_dir: str
    db_name: str
    db_port: int
    db_url: str
    database_path: str
    pg0_version: str | None
    psycopg_version: str | None
    psycopg_driver: str | None
    vector_extension: dict[str, Any] | None
    embedding: dict[str, Any]
    data_hash: str | None
    precondition_error: str | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "runtime_dir": self.runtime_dir,
            "db_name": self.db_name,
            "db_port": self.db_port,
            "db_url": redacted_db_url(self.db_url),
            "database_path": self.database_path,
            "pg0_version": self.pg0_version,
            "psycopg_version": self.psycopg_version,
            "psycopg_driver": self.psycopg_driver,
            "vector_extension": self.vector_extension,
            "embedding": self.embedding,
            "data_hash": self.data_hash,
            "precondition_error": self.precondition_error,
        }


class PgVectorRuntime:
    """受命名保护的 pg0 临时实例。"""

    def __init__(
        self,
        runtime_dir: str | Path = DEFAULT_RUNTIME_DIR,
        *,
        db_name: str = DEFAULT_DB_NAME,
        db_port: int = DEFAULT_DB_PORT,
    ) -> None:
        self.runtime_dir = Path(runtime_dir)
        self.db_name = db_name
        self.db_port = db_port
        self.database_path = self.runtime_dir / "database"
        self.manifest_path = self.runtime_dir / MANIFEST_NAME
        self._validate_identity()

    @property
    def db_url(self) -> str:
        return (
            f"postgresql://{DEFAULT_DB_ROLE}:{DEFAULT_DB_PASSWORD}"
            f"@127.0.0.1:{self.db_port}/postgres"
        )

    def _validate_identity(self) -> None:
        if not self.db_name.startswith("notalone-pgvector-"):
            raise ValueError("拒绝操作未以 notalone-pgvector- 开头的数据库实例")
        if not (1024 <= self.db_port <= 65535):
            raise ValueError("数据库端口无效")
        if self.runtime_dir == Path("/") or len(self.runtime_dir.parts) < 3:
            raise ValueError("拒绝使用过于宽泛的 runtime 目录")

    def _pg0_class(self) -> Any:
        try:
            return importlib.import_module("pg0").Pg0
        except ImportError as exc:
            raise RuntimeUnavailableError(
                "缺少 pg0-embedded；请在实验专用 Python 环境中安装，未连接任何业务库。"
            ) from exc

    def _pg0(self) -> Any:
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        pg0 = self._pg0_class()
        return pg0(name=self.db_name, port=self.db_port, data_dir=str(self.database_path))

    def start(self) -> dict[str, Any]:
        instance = self._pg0()
        if not instance.running:
            instance.start()
        return self.status()

    def stop(self) -> dict[str, Any]:
        instance = self._pg0()
        if instance.running:
            instance.stop()
        return self.status()

    def status(self) -> dict[str, Any]:
        instance = self._pg0()
        return {"running": bool(instance.running), "info": instance.info() if instance.running else None}

    def drop(self) -> None:
        """停止并删除本实验实例，不删除其他 pg0。"""

        instance = self._pg0()
        if instance.running:
            instance.stop()
        instance.drop(force=True)

    def connect(self) -> Any:
        """连接实验默认 database；拒绝从环境读取 DATABASE_URL。"""

        try:
            driver = importlib.import_module("psycopg")
            connection = driver.connect(self.db_url)
            connection.autocommit = False
            return connection
        except ImportError:
            try:
                # Hindsight 的独立 venv 可能只带 psycopg2；两者都只连接
                # 本实验固定 loopback URL，不读取 DATABASE_URL 等环境变量。
                driver = importlib.import_module("psycopg2")
                connection = driver.connect(self.db_url)
                try:
                    extras = importlib.import_module("psycopg2.extras")
                    extras.register_uuid(conn_or_curs=connection)
                except (ImportError, AttributeError):
                    # store 同时把 UUID 参数显式转为字符串；注册只是让读取
                    # UUID 列时尽量保留 UUID 类型，旧 psycopg2 版本不阻塞实验。
                    pass
                connection.autocommit = False
                return connection
            except ImportError as exc:
                raise RuntimeUnavailableError(
                    "缺少 psycopg/psycopg2；未连接业务数据库。"
                ) from exc
        except Exception as exc:  # noqa: BLE001 - 保留实际前提错误
            raise RuntimeUnavailableError(
                f"无法连接独立 pgvector 临时数据库 {self.db_name}:{self.db_port}"
            ) from exc

    def probe(self, *, embedding: EmbeddingSpec | None = None) -> RuntimeEvidence:
        """探测 pg0、psycopg 和 vector 扩展，写入可重跑 manifest。"""

        spec = embedding or EmbeddingSpec()
        pg0_version = _package_version("pg0-embedded")
        psycopg_version = (
            _package_version("psycopg")
            or _package_version("psycopg-binary")
            or _package_version("psycopg2-binary")
            or _package_version("psycopg2")
        )
        psycopg_driver = _available_driver()
        extension: dict[str, Any] | None = None
        precondition_error: str | None = None
        try:
            connection = self.connect()
            try:
                extension = VectorTable(dimensions=spec.dimensions, model_id=spec.model_id).extension_info(
                    connection
                )
            finally:
                connection.close()
        except (RuntimeUnavailableError, RuntimeError) as exc:
            precondition_error = str(exc)
        evidence = RuntimeEvidence(
            runtime_dir=str(self.runtime_dir),
            db_name=self.db_name,
            db_port=self.db_port,
            db_url=self.db_url,
            database_path=str(self.database_path),
            pg0_version=pg0_version,
            psycopg_version=psycopg_version,
            psycopg_driver=psycopg_driver,
            vector_extension=extension,
            embedding={
                "model_id": spec.model_id,
                "model_revision": spec.model_revision,
                "dimensions": spec.dimensions,
                "normalize": spec.normalize,
            },
            data_hash=None,
            precondition_error=precondition_error,
        )
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.manifest_path.write_text(
            json.dumps(evidence.as_dict(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return evidence

    def initialize_vector_table(self, *, hnsw: bool = True) -> dict[str, Any]:
        """在临时数据库中创建 vector 扩展和实验表。"""

        connection = self.connect()
        try:
            result = VectorTable().initialize(connection, hnsw=hnsw)
        finally:
            connection.close()
        evidence = self.probe()
        manifest = evidence.as_dict()
        manifest["vector_table"] = result
        self.manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return result

    def cleanup(self, *, remove_runtime_dir: bool = False) -> None:
        """清理仅由本实验创建的数据库实例和可选 runtime 目录。"""

        self.drop()
        if remove_runtime_dir:
            if self.runtime_dir.exists():
                shutil.rmtree(self.runtime_dir)

    def record_data_hash(self, paths: list[str | Path]) -> str:
        """记录合成资料文件摘要，不读取业务目录。"""

        digest = hashlib.sha256()
        for path in sorted(Path(item) for item in paths):
            if not path.is_file():
                raise FileNotFoundError(path)
            digest.update(str(path).encode("utf-8"))
            digest.update(b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
        value = digest.hexdigest()
        if self.manifest_path.exists():
            manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        else:
            manifest = self.probe().as_dict()
        manifest["data_hash"] = value
        self.manifest_path.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return value


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _available_driver() -> str | None:
    for name in ("psycopg", "psycopg2"):
        try:
            importlib.import_module(name)
            return name
        except ImportError:
            continue
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="临时 pgvector 记忆召回实验运行时")
    parser.add_argument("operation", choices=("start", "stop", "status", "probe", "init", "cleanup"))
    parser.add_argument("--runtime-dir", type=Path, default=DEFAULT_RUNTIME_DIR)
    parser.add_argument("--remove-runtime-dir", action="store_true")
    parser.add_argument("--no-hnsw", action="store_true")
    args = parser.parse_args()
    runtime = PgVectorRuntime(args.runtime_dir)
    if args.operation == "start":
        output = runtime.start()
    elif args.operation == "stop":
        output = runtime.stop()
    elif args.operation == "status":
        output = runtime.status()
    elif args.operation == "probe":
        output = runtime.probe().as_dict()
    elif args.operation == "init":
        output = runtime.initialize_vector_table(hnsw=not args.no_hnsw)
    else:
        runtime.cleanup(remove_runtime_dir=args.remove_runtime_dir)
        output = {"cleaned": True}
    print(json.dumps(output, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()

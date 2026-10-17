"""读取和持久化本地受控运行配置。"""

from __future__ import annotations

from collections.abc import Mapping
import os
import tempfile
from pathlib import Path
from uuid import UUID


ENV_FILE_VARIABLE = "NOTALONE_ENV_FILE"
DISABLE_ENV_FILE_VARIABLE = "NOTALONE_DISABLE_DOTENV"


def load_project_env() -> Path | None:
    """读取项目 ``.env``；已有进程环境变量优先。"""

    if os.environ.get(DISABLE_ENV_FILE_VARIABLE) == "1":
        return None
    path = _existing_env_path()
    if path is None:
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        key, value = _parse_line(line)
        if key is not None and key not in os.environ:
            os.environ[key] = value
    return path


def persist_owner_id(owner_id: UUID, env_path: Path | None = None) -> Path:
    """把生成的 owner UUID 原子写入受控本地 ``.env``。"""

    return persist_env_values({"NOTALONE_OWNER_ID": str(owner_id)}, env_path)


def persist_env_values(values: Mapping[str, str], env_path: Path | None = None) -> Path:
    """按加载器的解析规则移除本次键的全部旧赋值，再原子保存。"""

    path = env_path or _writable_env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    output = [
        line for line in existing.splitlines(keepends=True)
        if _parse_line(line)[0] not in values
    ]
    if output and not output[-1].endswith("\n"):
        output.append("\n")
    output.extend(f"{key}={value}\n" for key, value in values.items())

    temporary_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = temporary.name
            os.chmod(temporary.name, 0o600)
            temporary.write("".join(output))
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except OSError:
                pass
    return path


def _existing_env_path() -> Path | None:
    configured = os.environ.get(ENV_FILE_VARIABLE, "").strip()
    if configured:
        path = Path(configured).expanduser()
        return path if path.is_file() else None
    current = Path.cwd().resolve()
    for directory in (current, *current.parents):
        path = directory / ".env"
        if path.is_file():
            return path
    return None


def _writable_env_path() -> Path:
    configured = os.environ.get(ENV_FILE_VARIABLE, "").strip()
    if configured:
        return Path(configured).expanduser()
    existing = _existing_env_path()
    return existing if existing is not None else Path.cwd() / ".env"


def _parse_line(line: str) -> tuple[str | None, str]:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None, ""
    if stripped.startswith("export "):
        stripped = stripped[7:].lstrip()
    if "=" not in stripped:
        return None, ""
    key, value = stripped.split("=", 1)
    key = key.strip()
    if not key or not key.replace("_", "").isalnum():
        return None, ""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        value = value[1:-1]
    return key, value

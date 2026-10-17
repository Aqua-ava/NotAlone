"""首启向导的统一应用层入口。

owner 初始化与导入命令的 --initialize-owner 保持同一事务语义与幂等
行为（同一张 owner 表、ON CONFLICT 不重复创建）；凭据写入受控本地
.env（0600），界面与错误信息均不回显密钥。
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Protocol
from uuid import UUID, uuid4

from notalone.runtime_config import persist_env_values, persist_owner_id


class OwnerAlreadyConfigured(RuntimeError):
    """仅创建模式发现既有身份；拒绝选择或写回任意既有 owner。"""


class OwnerDirectory(Protocol):
    """owner 初始化所需的最小持久化边界。"""

    def list_owners(self) -> tuple[object, ...]: ...

    def create_owner(self, owner_id: UUID, display_name: str) -> object: ...

    def owner_exists(self, owner_id: UUID) -> bool: ...

    def create_owner_if_empty(self, owner_id: UUID, display_name: str) -> object | None: ...


class SetupService:
    """首启向导：owner 初始化（幂等）与凭据写入（受控）。"""

    __slots__ = ("_owner_directory", "_env_path")

    def __init__(
        self,
        *,
        owner_directory: OwnerDirectory,
        env_path: Path | None = None,
    ) -> None:
        self._owner_directory = owner_directory
        self._env_path = env_path

    def status(self, *, runtime_owner_id: UUID | None = None) -> dict[str, object]:
        owners = self._owner_directory.list_owners()
        configured = bool(
            os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "").strip()
        )
        return {
            "initialized": len(owners) > 0,
            "owner_configured": len(owners) > 0,
            "credentials_configured": configured,
            "official_deepseek_defaults": (
                os.environ.get("NOTALONE_DEEPSEEK_MODEL", "deepseek-flash") == "deepseek-flash"
                and os.environ.get("NOTALONE_DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
                in ("https://api.deepseek.com", "https://api.deepseek.com/v1")
            ),
            # 由当前实例注入，不接受 HTTP 调用方指定；全库状态不是身份凭证。
            "runtime_owner_configured": (
                runtime_owner_id is not None
                and self._owner_directory.owner_exists(runtime_owner_id)
            ),
        }

    def initialize_owner(self, *, display_name: str, create_only: bool = False) -> dict[str, object]:
        """App 仅创建；既有明确恢复调用保留幂等返回与写回语义。"""

        name = display_name.strip()
        if not name:
            raise ValueError("owner 展示名称不能为空。")
        if create_only:
            owner_id = uuid4()
            if self._owner_directory.create_owner_if_empty(owner_id, name) is None:
                raise OwnerAlreadyConfigured("本人已配置。")
            self._persist_owner_id(owner_id)
            return {"owner_id": str(owner_id), "created": True}
        owners = self._owner_directory.list_owners()
        if owners:
            owner_id = getattr(owners[0], "id", None)
            if owner_id is None:
                owner_id = getattr(owners[0], "owner_id", None)
            if owner_id is None:
                raise RuntimeError("owner 初始化结果结构无效。")
            # 既有 owner 也把 id 写入 .env：避免后端进程以 owner 未初始化
            # 模式运行导致重启循环（AppModel 向导完成后会重启后端）。
            self._persist_owner_id(owner_id)
            return {"owner_id": str(owner_id), "created": False}
        owner_id = uuid4()
        self._owner_directory.create_owner(owner_id, name)
        self._persist_owner_id(owner_id)
        return {"owner_id": str(owner_id), "created": True}

    def write_credentials(self, *, api_key: str) -> dict[str, object]:
        """把模型凭据写入受控 .env（0600）；不回显密钥。"""

        key = api_key.strip()
        if not key:
            raise ValueError("模型凭据不能为空。")
        persist_env_values({"NOTALONE_DEEPSEEK_API_KEY": key}, self._env_path)
        os.environ["NOTALONE_DEEPSEEK_API_KEY"] = key
        return {"provider": "deepseek", "configured": True}

    def use_official_deepseek(self, *, api_key: str) -> dict[str, object]:
        """用户确认官方接收方并亲输新密钥后，原子保存三项配置。"""

        if not isinstance(api_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,4096}", api_key):
            raise ValueError("请重新输入对应的官方模型密钥。")
        values = {
            "NOTALONE_DEEPSEEK_API_KEY": api_key,
            "NOTALONE_DEEPSEEK_MODEL": "deepseek-flash",
            "NOTALONE_DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        }
        persist_env_values(values, self._env_path)
        os.environ.update(values)
        return {"provider": "deepseek", "configured": True, "official_deepseek_defaults": True}

    # -- 辅助 ----------------------------------------------------------

    def _persist_owner_id(self, owner_id: UUID) -> None:
        persist_owner_id(owner_id, self._env_path)

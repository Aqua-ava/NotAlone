"""本地 Skill 包的受控文件读取适配器。"""

from __future__ import annotations

import mimetypes
import os
import stat
from pathlib import Path, PurePosixPath

from notalone.skills.package import (
    MAX_RESOURCE_BYTES,
    MAX_RESOURCE_COUNT,
    MAX_RESOURCE_TOTAL_BYTES,
    RawSkillPackage,
    RawSkillPackageResource,
    SkillPackageValidationError,
    _ALLOWED_TOP_LEVEL_DIRECTORIES,
    _ASSET_SUFFIXES,
    _REFERENCE_SUFFIXES,
    _UNSUPPORTED_MEDIA_SUFFIXES,
)

_NOFOLLOW_FLAG = getattr(os, "O_NOFOLLOW", 0)
_DIRECTORY_FLAG = getattr(os, "O_DIRECTORY", 0)


class LocalSkillPackageReader:
    """读取用户明确选择的本地目录，不解析或执行其内容。"""

    def read(self, package_path: str | Path) -> RawSkillPackage:
        root = self._package_root(package_path)
        self._top_level_entries(root)
        skill_path = root / "SKILL.md"
        if not skill_path.exists():
            raise SkillPackageValidationError(
                "missing_skill_file",
                "缺少 SKILL.md。",
            )
        skill_document = self._read_file(
            root,
            "SKILL.md",
            MAX_RESOURCE_BYTES,
        )

        resources: list[RawSkillPackageResource] = []
        total_bytes = 0
        for directory_name in sorted(_ALLOWED_TOP_LEVEL_DIRECTORIES):
            directory = root / directory_name
            if not directory.exists():
                continue
            for path in self._resource_files(directory, root):
                if len(resources) >= MAX_RESOURCE_COUNT:
                    raise SkillPackageValidationError(
                        "resource_count_exceeded",
                        "辅助资源数量超过限制。",
                    )
                relative_path = path.relative_to(root).as_posix()
                resource_bytes = self._read_file(
                    root,
                    relative_path,
                    MAX_RESOURCE_BYTES,
                )
                total_bytes += len(resource_bytes)
                if total_bytes > MAX_RESOURCE_TOTAL_BYTES:
                    raise SkillPackageValidationError(
                        "resource_budget_exceeded",
                        "辅助资源总大小超过限制。",
                    )
                resource_kind = (
                    "reference"
                    if relative_path.startswith("references/")
                    else "asset"
                )
                resources.append(
                    RawSkillPackageResource(
                        relative_path=relative_path,
                        resource_kind=resource_kind,
                        media_type=self._media_type(path, resource_kind),
                        content=resource_bytes,
                    )
                )

        return RawSkillPackage(
            package_name=root.name,
            skill_document=skill_document,
            resources=tuple(resources),
        )

    @staticmethod
    def _package_root(package_path: str | Path) -> Path:
        if not isinstance(package_path, (str, Path)):
            raise SkillPackageValidationError("invalid_package", "包路径无效。")
        try:
            root = Path(package_path)
            if root.is_symlink() or not root.is_dir():
                raise SkillPackageValidationError(
                    "invalid_package",
                    "包必须是本地目录。",
                )
            return root.resolve(strict=True)
        except SkillPackageValidationError:
            raise
        except (OSError, RuntimeError, ValueError):
            raise SkillPackageValidationError(
                "invalid_package",
                "包目录无法读取。",
            ) from None

    @staticmethod
    def _top_level_entries(root: Path) -> tuple[Path, ...]:
        try:
            entries = tuple(sorted(root.iterdir(), key=lambda path: path.name))
        except OSError:
            raise SkillPackageValidationError(
                "invalid_package",
                "包目录无法读取。",
            ) from None
        for entry in entries:
            if entry.is_symlink():
                raise SkillPackageValidationError(
                    "symlink_not_allowed",
                    "包不能包含符号链接。",
                )
            if entry.name == "SKILL.md":
                if not entry.is_file():
                    raise SkillPackageValidationError(
                        "invalid_skill_file",
                        "SKILL.md 必须是普通文件。",
                    )
                continue
            if entry.is_dir() and entry.name in _ALLOWED_TOP_LEVEL_DIRECTORIES:
                continue
            raise SkillPackageValidationError(
                "unsupported_entry",
                "包包含不支持的文件或目录。",
            )
        return entries

    @classmethod
    def _resource_files(cls, directory: Path, root: Path) -> tuple[Path, ...]:
        files: list[Path] = []
        try:
            with os.scandir(directory) as scanner:
                entries = sorted(scanner, key=lambda entry: entry.name)
            for entry in entries:
                path = Path(entry.path)
                if entry.is_symlink():
                    raise SkillPackageValidationError(
                        "symlink_not_allowed",
                        "包不能包含符号链接。",
                    )
                relative = path.relative_to(root).as_posix()
                parts = PurePosixPath(relative).parts
                if (
                    not parts
                    or any(part in ("", ".", "..") for part in parts)
                    or any("\\" in part for part in parts)
                    or any(part.startswith(".") for part in parts)
                ):
                    raise SkillPackageValidationError(
                        "invalid_resource_path",
                        "辅助资源路径无效。",
                    )
                if entry.is_dir(follow_symlinks=False):
                    files.extend(cls._resource_files(path, root))
                    continue
                if not entry.is_file(follow_symlinks=False):
                    raise SkillPackageValidationError(
                        "invalid_resource_type",
                        "辅助资源必须是普通文件。",
                    )
                suffix = path.suffix.lower()
                if suffix in _UNSUPPORTED_MEDIA_SUFFIXES:
                    raise SkillPackageValidationError(
                        "unsupported_resource_type",
                        "辅助资源类型不受支持。",
                    )
                allowed_suffixes = (
                    _REFERENCE_SUFFIXES
                    if parts[0] == "references"
                    else _ASSET_SUFFIXES
                )
                if suffix not in allowed_suffixes:
                    raise SkillPackageValidationError(
                        "unsupported_resource_type",
                        "辅助资源类型不受支持。",
                    )
                files.append(path)
        except SkillPackageValidationError:
            raise
        except (OSError, ValueError):
            raise SkillPackageValidationError(
                "invalid_resource",
                "辅助资源无法读取。",
            ) from None
        return tuple(files)

    @classmethod
    def _read_file(
        cls,
        root: Path,
        relative_path: str,
        maximum_bytes: int,
    ) -> bytes:
        file_descriptor = -1
        try:
            file_descriptor = cls._open_package_file(root, relative_path)
            file_stat = os.fstat(file_descriptor)
            if not stat.S_ISREG(file_stat.st_mode):
                raise SkillPackageValidationError(
                    "invalid_resource_type",
                    "包文件必须是普通文件。",
                )
            if file_stat.st_size > maximum_bytes:
                raise SkillPackageValidationError(
                    "resource_size_exceeded",
                    "Skill 文件大小超过限制。",
                )
            with os.fdopen(file_descriptor, "rb") as stream:
                file_descriptor = -1
                content = stream.read(maximum_bytes + 1)
        except SkillPackageValidationError:
            raise
        except (OSError, ValueError):
            raise SkillPackageValidationError(
                "unreadable_file",
                "Skill 文件无法读取。",
            ) from None
        finally:
            if file_descriptor >= 0:
                os.close(file_descriptor)
        if len(content) > maximum_bytes:
            raise SkillPackageValidationError(
                "resource_size_exceeded",
                "Skill 文件大小超过限制。",
            )
        return content

    @classmethod
    def _open_package_file(cls, root: Path, relative_path: str) -> int:
        parts = PurePosixPath(relative_path).parts
        if not parts:
            raise ValueError("empty relative path")
        directory_descriptors: list[int] = []
        try:
            root_descriptor = os.open(
                root,
                os.O_RDONLY | _NOFOLLOW_FLAG | _DIRECTORY_FLAG,
            )
            directory_descriptors.append(root_descriptor)
            current_descriptor = root_descriptor
            for part in parts[:-1]:
                next_descriptor = os.open(
                    part,
                    os.O_RDONLY | _NOFOLLOW_FLAG | _DIRECTORY_FLAG,
                    dir_fd=current_descriptor,
                )
                directory_descriptors.append(next_descriptor)
                current_descriptor = next_descriptor
            return os.open(
                parts[-1],
                os.O_RDONLY | _NOFOLLOW_FLAG,
                dir_fd=current_descriptor,
            )
        finally:
            for descriptor in reversed(directory_descriptors):
                os.close(descriptor)

    @staticmethod
    def _media_type(path: Path, resource_kind: str) -> str:
        suffix = path.suffix.lower()
        known_types = {
            ".md": "text/markdown",
            ".markdown": "text/markdown",
            ".txt": "text/plain",
            ".csv": "text/csv",
            ".json": "application/json",
            ".yaml": "application/yaml",
            ".yml": "application/yaml",
            ".xml": "application/xml",
            ".template": "text/plain",
            ".tmpl": "text/plain",
        }
        media_type = known_types.get(suffix) or mimetypes.guess_type(path.name)[0]
        if media_type is None:
            media_type = (
                "application/octet-stream"
                if resource_kind == "asset"
                else "text/plain"
            )
        return media_type

"""本地 Reply Skill 包的校验和规范化。"""

from __future__ import annotations

import hashlib
import mimetypes
import os
import re
import stat
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from notalone.skills.models import (
    SkillPackage,
    SkillPackageResource,
    _validate_skill_name,
)


MAX_SKILL_LINES = 500
MAX_SKILL_ESTIMATED_TOKENS = 5_000
MAX_RESOURCE_COUNT = 100
MAX_RESOURCE_BYTES = 1 * 1024 * 1024
MAX_RESOURCE_TOTAL_BYTES = 4 * 1024 * 1024
MAX_DESCRIPTION_LENGTH = 1_024

_ALLOWED_TOP_LEVEL_DIRECTORIES = {"references", "assets"}
_REFERENCE_SUFFIXES = {
    ".csv",
    ".json",
    ".markdown",
    ".md",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
_ASSET_SUFFIXES = _REFERENCE_SUFFIXES | {
    ".gif",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".template",
    ".tmpl",
    ".webp",
}
_UNSUPPORTED_MEDIA_SUFFIXES = {
    ".7z",
    ".aac",
    ".avi",
    ".bash",
    ".bat",
    ".bin",
    ".bz2",
    ".cmd",
    ".com",
    ".dll",
    ".exe",
    ".flac",
    ".flv",
    ".gz",
    ".jar",
    ".js",
    ".m4a",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".mpeg",
    ".mpg",
    ".py",
    ".pyc",
    ".rar",
    ".sh",
    ".so",
    ".tar",
    ".ts",
    ".wav",
    ".webm",
    ".whl",
    ".zip",
}
_TEXT_SUFFIXES = _REFERENCE_SUFFIXES | {
    ".css",
    ".html",
    ".template",
    ".tmpl",
}
_URL_PATTERN = re.compile(r"\bhttps?://", re.IGNORECASE)
_PRIVATE_EXPORT_MARKERS = (
    '"sender_wxid"',
    '"external_local_id"',
    '"external_talker"',
    '"raw_payload"',
    '"source_document_id"',
)
_UNSAFE_INSTRUCTION_PATTERNS = (
    re.compile(
        r"\b(?:run|execute)\s+(?:bash|shell|sh|python|script|command)\b",
        re.I,
    ),
    re.compile(r"\b(?:curl|wget)\s+", re.I),
    re.compile(r"(?:执行|运行)(?:任意)?(?:脚本|shell|命令)"),
    re.compile(r"(?:访问|请求|下载)(?:外部)?网络"),
    re.compile(r"(?:发送|代发)(?:消息|回复)"),
    re.compile(r"(?:修改|删除|写入)(?:文件|数据库|记忆)"),
    re.compile(r"(?:调用|注册|创建)(?:Tool|MCP|工具)", re.I),
    re.compile(
        r"(?:ignore|override)\s+(?:previous|system)\s+instructions",
        re.I,
    ),
    re.compile(r"(?:忽略|覆盖)(?:之前|系统)(?:的)?指令"),
)
_NEGATION_PATTERN = re.compile(
    r"(?:不要|禁止|不能|不得|不可|不应|不可以|不会|不自动|避免|"
    r"仅供文本|只允许|do not|don't|must not|never|without|avoid|"
    r"cannot|can't|won't)\s*$",
    re.IGNORECASE,
)


class SkillPackageValidationError(ValueError):
    """本地 Skill 包无法安全进入 Skill Library。"""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"Skill 包校验失败：{message}")


class _UniqueKeyLoader(yaml.SafeLoader):
    """拒绝 frontmatter 中静默覆盖的重复 YAML 键。"""


def _construct_unique_mapping(
    loader: _UniqueKeyLoader,
    node: yaml.MappingNode,
    deep: bool = False,
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.YAMLError("duplicate key")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


_UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


class SkillPackageValidator:
    """把用户明确选择的本地目录转换为安全的 Skill 包值对象。"""

    def validate(self, package_path: str | Path) -> SkillPackage:
        root = self._package_root(package_path)
        self._top_level_entries(root)
        skill_path = root / "SKILL.md"
        if not skill_path.exists():
            raise SkillPackageValidationError(
                "missing_skill_file",
                "缺少 SKILL.md。",
            )
        skill_bytes = self._read_file(skill_path, MAX_RESOURCE_BYTES)
        name, description, content = self._parse_skill_document(
            skill_bytes,
            package_name=root.name,
        )
        self._validate_content_safety(description)
        self._validate_content_safety(content)

        resources: list[SkillPackageResource] = []
        total_bytes = 0
        for directory_name in sorted(_ALLOWED_TOP_LEVEL_DIRECTORIES):
            directory = root / directory_name
            if not directory.exists():
                continue
            for path in self._resource_files(directory, root):
                relative_path = path.relative_to(root).as_posix()
                resource_bytes = self._read_file(path, MAX_RESOURCE_BYTES)
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
                media_type = self._media_type(path, resource_kind)
                if path.suffix.lower() in _TEXT_SUFFIXES:
                    try:
                        text = resource_bytes.decode("utf-8")
                    except UnicodeDecodeError:
                        raise SkillPackageValidationError(
                            "invalid_encoding",
                            "文本辅助资源必须使用 UTF-8。",
                        ) from None
                    if "\x00" in text:
                        raise SkillPackageValidationError(
                            "invalid_text",
                            "文本辅助资源包含无效内容。",
                        )
                    self._validate_content_safety(text)
                if len(resources) >= MAX_RESOURCE_COUNT:
                    raise SkillPackageValidationError(
                        "resource_count_exceeded",
                        "辅助资源数量超过限制。",
                    )
                resources.append(
                    SkillPackageResource(
                        relative_path=relative_path,
                        resource_kind=resource_kind,
                        media_type=media_type,
                        content=resource_bytes,
                        content_sha256=hashlib.sha256(resource_bytes).hexdigest(),
                    )
                )

        package_sha256 = self._package_hash(skill_bytes, resources)
        return SkillPackage(
            name=name,
            description=description,
            content=content,
            content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            package_sha256=package_sha256,
            resources=tuple(resources),
            warnings=self._quality_warnings(content),
        )

    @staticmethod
    def _package_root(package_path: str | Path) -> Path:
        if not isinstance(package_path, (str, Path)):
            raise SkillPackageValidationError("invalid_package", "包路径无效。")
        root = Path(package_path)
        try:
            if root.is_symlink() or not root.is_dir():
                raise SkillPackageValidationError(
                    "invalid_package",
                    "包必须是本地目录。",
                )
            return root.resolve(strict=True)
        except SkillPackageValidationError:
            raise
        except (OSError, RuntimeError):
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
                if path.suffix.lower() in _UNSUPPORTED_MEDIA_SUFFIXES:
                    raise SkillPackageValidationError(
                        "unsupported_resource_type",
                        "辅助资源类型不受支持。",
                    )
                allowed_suffixes = (
                    _REFERENCE_SUFFIXES
                    if parts[0] == "references"
                    else _ASSET_SUFFIXES
                )
                if path.suffix.lower() not in allowed_suffixes:
                    raise SkillPackageValidationError(
                        "unsupported_resource_type",
                        "辅助资源类型不受支持。",
                    )
                files.append(path)
        except SkillPackageValidationError:
            raise
        except OSError:
            raise SkillPackageValidationError(
                "invalid_resource",
                "辅助资源无法读取。",
            ) from None
        return tuple(files)

    @staticmethod
    def _read_file(path: Path, maximum_bytes: int) -> bytes:
        try:
            file_stat = path.stat()
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
            content = path.read_bytes()
        except SkillPackageValidationError:
            raise
        except (OSError, ValueError):
            raise SkillPackageValidationError(
                "unreadable_file",
                "Skill 文件无法读取。",
            ) from None
        if len(content) > maximum_bytes:
            raise SkillPackageValidationError(
                "resource_size_exceeded",
                "Skill 文件大小超过限制。",
            )
        return content

    @classmethod
    def _parse_skill_document(
        cls,
        raw: bytes,
        *,
        package_name: str,
    ) -> tuple[str, str, str]:
        try:
            document = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise SkillPackageValidationError(
                "invalid_encoding",
                "SKILL.md 必须使用 UTF-8。",
            ) from None
        if document.startswith("\ufeff"):
            raise SkillPackageValidationError(
                "invalid_encoding",
                "SKILL.md 不允许 UTF-8 BOM。",
            )
        lines = document.splitlines(keepends=True)
        if not lines or lines[0].strip() != "---":
            raise SkillPackageValidationError(
                "missing_frontmatter",
                "SKILL.md 必须包含 frontmatter。",
            )
        closing_index = next(
            (
                index
                for index, line in enumerate(lines[1:], start=1)
                if line.strip() == "---"
            ),
            None,
        )
        if closing_index is None:
            raise SkillPackageValidationError(
                "invalid_frontmatter",
                "SKILL.md frontmatter 未闭合。",
            )
        try:
            metadata = yaml.load(
                "".join(lines[1:closing_index]),
                Loader=_UniqueKeyLoader,
            )
        except yaml.YAMLError:
            raise SkillPackageValidationError(
                "invalid_frontmatter",
                "SKILL.md frontmatter 无法解析。",
            ) from None
        if not isinstance(metadata, dict):
            raise SkillPackageValidationError(
                "invalid_frontmatter",
                "SKILL.md frontmatter 必须是对象。",
            )
        name = metadata.get("name")
        description = metadata.get("description")
        if not isinstance(name, str):
            raise SkillPackageValidationError(
                "missing_name",
                "SKILL.md 必须声明 name。",
            )
        try:
            _validate_skill_name(name)
        except (TypeError, ValueError):
            raise SkillPackageValidationError(
                "invalid_name",
                "Skill name 格式无效。",
            ) from None
        if name != package_name:
            raise SkillPackageValidationError(
                "name_mismatch",
                "Skill name 必须与包目录名称一致。",
            )
        if not isinstance(description, str) or not description.strip():
            raise SkillPackageValidationError(
                "missing_description",
                "SKILL.md 必须声明 description。",
            )
        description = description.strip()
        if len(description) > MAX_DESCRIPTION_LENGTH:
            raise SkillPackageValidationError(
                "description_too_long",
                "Skill description 超过长度限制。",
            )
        content = "".join(lines[closing_index + 1 :]).lstrip("\r\n")
        if not content.strip():
            raise SkillPackageValidationError(
                "empty_content",
                "SKILL.md 正文不能为空。",
            )
        if len(lines) > MAX_SKILL_LINES:
            raise SkillPackageValidationError(
                "skill_size_exceeded",
                "SKILL.md 行数超过限制。",
            )
        if cls._estimate_tokens(document) > MAX_SKILL_ESTIMATED_TOKENS:
            raise SkillPackageValidationError(
                "skill_budget_exceeded",
                "SKILL.md 估算 token 数超过限制。",
            )
        return name, description, content

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        tokens = 0
        ascii_run = 0
        for character in text:
            if character.isascii() and character.isalnum():
                ascii_run += 1
                continue
            if ascii_run:
                tokens += max(1, (ascii_run + 3) // 4)
                ascii_run = 0
            if character.isspace():
                continue
            tokens += 1
        if ascii_run:
            tokens += max(1, (ascii_run + 3) // 4)
        return tokens

    @staticmethod
    def _validate_content_safety(content: str) -> None:
        if _URL_PATTERN.search(content):
            raise SkillPackageValidationError(
                "external_url",
                "Skill 包不能依赖外部 URL。",
            )
        compact = content.casefold()
        if sum(
            marker.casefold() in compact for marker in _PRIVATE_EXPORT_MARKERS
        ) >= 2:
            raise SkillPackageValidationError(
                "private_export",
                "Skill 包不能包含联系人或聊天导出数据。",
            )
        for line in content.splitlines():
            for pattern in _UNSAFE_INSTRUCTION_PATTERNS:
                match = pattern.search(line)
                if match is None:
                    continue
                prefix = line[: match.start()].rstrip()
                if _NEGATION_PATTERN.search(prefix):
                    continue
                raise SkillPackageValidationError(
                    "unsafe_instruction",
                    "Skill 包包含未授权的执行或出站指令。",
                )

    @staticmethod
    def _quality_warnings(content: str) -> tuple[str, ...]:
        non_empty_lines = tuple(line for line in content.splitlines() if line.strip())
        if len(non_empty_lines) < 3:
            return (
                "Skill 正文较短，建议补充适用场景、步骤、"
                "示例和边界。",
            )
        return ()

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

    @staticmethod
    def _package_hash(
        skill_bytes: bytes,
        resources: list[SkillPackageResource],
    ) -> str:
        digest = hashlib.sha256()
        digest.update(b"SKILL.md\0")
        digest.update(skill_bytes)
        for resource in resources:
            digest.update(resource.relative_path.encode("utf-8"))
            digest.update(b"\0")
            digest.update(resource.content)
            digest.update(b"\0")
        return digest.hexdigest()

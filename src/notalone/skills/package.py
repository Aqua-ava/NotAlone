"""本地 Reply Skill 包的解析、校验和规范化。"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Literal

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
    ".svg",
    ".template",
    ".tmpl",
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
    ".svg",
    ".template",
    ".tmpl",
}
_URL_PATTERN = re.compile(r"\bhttps?://", re.IGNORECASE)
_PRIVATE_EXPORT_KEY_PATTERN = re.compile(
    r"['\"](?:sender_wxid|external_local_id|external_talker|"
    r"raw_payload|source_document_id)['\"]\s*:",
    re.IGNORECASE,
)
_PRIVATE_EXPORT_PATTERNS = (
    re.compile(
        r"(?:微信导出|微信聊天记录|聊天记录原文|原始聊天记录|"
        r"联系人资料|联系人信息)",
        re.IGNORECASE,
    ),
    re.compile(
        r"(?:姓名|微信号|手机号|手机号码|电话号码|联系人)\s*[:：]\s*"
        r"(?![<{\[])[^\s,，;；]+",
        re.IGNORECASE,
    ),
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
    r"不处理|不包含|不记录|不保存|不读取|不采集|不导入|不上传|"
    r"仅供文本|只允许|do not|don't|must not|never|without|avoid|"
    r"cannot|can't|won't)"
    r"(?:\s*(?:包含|记录|保存|读取|采集|导入|上传|处理))?\s*$",
    re.IGNORECASE,
)
_NEGATED_POLICY_PATTERN = re.compile(
    r"(?:不要|禁止|不能|不得|不可|不应|不可以|不会|不自动|避免|"
    r"不处理|不包含|不记录|不保存|不读取|不采集|不导入|不上传|"
    r"仅供文本|只允许|do not|don't|must not|never|without|avoid|"
    r"cannot|can't|won't)",
    re.IGNORECASE,
)
_UNSAFE_SVG_PATTERN = re.compile(
    r"<\s*script\b|\bon[a-z]+\s*=|"
    r"\b(?:href|xlink:href|src)\s*=\s*['\"]\s*(?:https?:|//|"
    r"javascript:)|\burl\(\s*['\"]?(?:https?:|//|javascript:)",
    re.I,
)
_USAGE_HINTS = (
    "适合",
    "用于",
    "使用",
    "场景",
    "需要",
    "说明",
    "策略",
    "when",
    "use",
    "for",
)


@dataclass(frozen=True, slots=True)
class RawSkillPackageResource:
    """文件读取层输出的未解析资源。"""

    relative_path: str
    resource_kind: Literal["reference", "asset"]
    media_type: str
    content: bytes


@dataclass(frozen=True, slots=True)
class RawSkillPackage:
    """文件读取层输出的未解析 Skill 包。"""

    package_name: str
    skill_document: bytes
    resources: tuple[RawSkillPackageResource, ...]


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
    """把读取层的 Skill 包转换为安全、可持久化的值对象。"""

    def validate(self, package: RawSkillPackage) -> SkillPackage:
        if not isinstance(package, RawSkillPackage):
            raise SkillPackageValidationError(
                "invalid_package",
                "Skill 包读取结果无效。",
            )
        if not isinstance(package.resources, tuple):
            raise SkillPackageValidationError(
                "invalid_package",
                "Skill 包资源清单无效。",
            )
        name, description, content = self._parse_skill_document(
            package.skill_document,
            package_name=package.package_name,
        )
        self._validate_content_safety(description)
        self._validate_content_safety(content)

        if len(package.resources) > MAX_RESOURCE_COUNT:
            raise SkillPackageValidationError(
                "resource_count_exceeded",
                "辅助资源数量超过限制。",
            )
        for raw_resource in package.resources:
            self._validate_resource_metadata(raw_resource)
        resource_paths = tuple(
            raw_resource.relative_path for raw_resource in package.resources
        )
        if len(resource_paths) != len(set(resource_paths)):
            raise SkillPackageValidationError(
                "duplicate_resource_path",
                "辅助资源路径不能重复。",
            )
        resources: list[SkillPackageResource] = []
        total_bytes = 0
        ordered_resources = tuple(
            sorted(package.resources, key=lambda resource: resource.relative_path)
        )
        for raw_resource in ordered_resources:
            resource_bytes = raw_resource.content
            total_bytes += len(resource_bytes)
            if total_bytes > MAX_RESOURCE_TOTAL_BYTES:
                raise SkillPackageValidationError(
                    "resource_budget_exceeded",
                    "辅助资源总大小超过限制。",
                )
            self._validate_resource_content(raw_resource.relative_path, resource_bytes)
            resources.append(
                SkillPackageResource(
                    relative_path=raw_resource.relative_path,
                    resource_kind=raw_resource.resource_kind,
                    media_type=raw_resource.media_type,
                    content=resource_bytes,
                    content_sha256=hashlib.sha256(resource_bytes).hexdigest(),
                )
            )

        package_sha256 = self._package_hash(package.skill_document, resources)
        return SkillPackage(
            name=name,
            description=description,
            content=content,
            content_sha256=hashlib.sha256(content.encode("utf-8")).hexdigest(),
            package_sha256=package_sha256,
            resources=tuple(resources),
            warnings=self._quality_warnings(description, content),
        )

    @classmethod
    def _validate_resource_metadata(
        cls,
        resource: RawSkillPackageResource,
    ) -> None:
        if not isinstance(resource, RawSkillPackageResource):
            raise SkillPackageValidationError(
                "invalid_resource",
                "辅助资源记录无效。",
            )
        if not isinstance(resource.relative_path, str):
            raise SkillPackageValidationError(
                "invalid_resource_path",
                "辅助资源路径无效。",
            )
        parts = PurePosixPath(resource.relative_path).parts
        if (
            not parts
            or parts[0] not in _ALLOWED_TOP_LEVEL_DIRECTORIES
            or any(part in ("", ".", "..") for part in parts)
            or any("\\" in part for part in parts)
            or any(part.startswith(".") for part in parts)
            or resource.relative_path.startswith("/")
            or resource.relative_path.endswith("/")
            or "//" in resource.relative_path
        ):
            raise SkillPackageValidationError(
                "invalid_resource_path",
                "辅助资源路径无效。",
            )
        expected_kind = (
            "reference" if parts[0] == "references" else "asset"
        )
        if resource.resource_kind != expected_kind:
            raise SkillPackageValidationError(
                "invalid_resource",
                "辅助资源类型与路径不一致。",
            )
        suffix = PurePosixPath(resource.relative_path).suffix.lower()
        if suffix in _UNSUPPORTED_MEDIA_SUFFIXES:
            raise SkillPackageValidationError(
                "unsupported_resource_type",
                "辅助资源类型不受支持。",
            )
        allowed_suffixes = (
            _REFERENCE_SUFFIXES
            if expected_kind == "reference"
            else _ASSET_SUFFIXES
        )
        if suffix not in allowed_suffixes:
            raise SkillPackageValidationError(
                "unsupported_resource_type",
                "辅助资源类型不受支持。",
            )
        if not isinstance(resource.media_type, str) or not resource.media_type.strip():
            raise SkillPackageValidationError(
                "invalid_resource",
                "辅助资源媒体类型无效。",
            )
        if not isinstance(resource.content, bytes):
            raise SkillPackageValidationError(
                "invalid_resource",
                "辅助资源内容无效。",
            )
        if len(resource.content) > MAX_RESOURCE_BYTES:
            raise SkillPackageValidationError(
                "resource_size_exceeded",
                "Skill 文件大小超过限制。",
            )

    @classmethod
    def _validate_resource_content(
        cls,
        relative_path: str,
        resource_bytes: bytes,
    ) -> None:
        suffix = PurePosixPath(relative_path).suffix.lower()
        if cls._is_forbidden_binary(resource_bytes):
            raise SkillPackageValidationError(
                "unsupported_resource_type",
                "辅助资源类型不受支持。",
            )
        if suffix not in _TEXT_SUFFIXES:
            return
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
        if suffix == ".svg" and _UNSAFE_SVG_PATTERN.search(text):
            raise SkillPackageValidationError(
                "unsafe_instruction",
                "SVG 资源包含脚本或事件处理器。",
            )
        cls._validate_content_safety(text)

    @staticmethod
    def _is_forbidden_binary(content: bytes) -> bool:
        if content.startswith(
            (
                b"PK\x03\x04",
                b"PK\x05\x06",
                b"PK\x07\x08",
                b"7z\xbc\xaf\x27\x1c",
                b"Rar!\x1a\x07",
                b"\x1f\x8b",
                b"BZh",
                b"\xfd7zXZ\x00",
                b"ID3",
                b"OggS",
                b"fLaC",
                b"MThd",
            )
        ):
            return True
        if len(content) >= 8 and content[4:8] == b"ftyp":
            return True
        if content.startswith(b"\x1a\x45\xdf\xa3"):
            return True
        return content.startswith(b"RIFF") and len(content) >= 12 and content[8:12] in (
            b"AVI ",
            b"WAVE",
        )

    @classmethod
    def _parse_skill_document(
        cls,
        raw: bytes,
        *,
        package_name: str,
    ) -> tuple[str, str, str]:
        if not isinstance(raw, bytes) or not isinstance(package_name, str):
            raise SkillPackageValidationError(
                "invalid_package",
                "SKILL.md 内容无效。",
            )
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
        except (TypeError, ValueError, yaml.YAMLError):
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

    @classmethod
    def _validate_content_safety(cls, content: str) -> None:
        if _URL_PATTERN.search(content):
            raise SkillPackageValidationError(
                "external_url",
                "Skill 包不能依赖外部 URL。",
            )
        compact = content.casefold()
        if (
            len(_PRIVATE_EXPORT_KEY_PATTERN.findall(compact)) >= 2
        ):
            raise SkillPackageValidationError(
                "private_export",
                "Skill 包不能包含联系人或聊天导出数据。",
            )
        for line in content.splitlines():
            for pattern in _PRIVATE_EXPORT_PATTERNS:
                match = pattern.search(line)
                if match is None:
                    continue
                prefix = line[: match.start()].rstrip()
                if cls._is_negated(prefix):
                    continue
                raise SkillPackageValidationError(
                    "private_export",
                    "Skill 包不能包含联系人或聊天导出数据。",
                )
            for pattern in _UNSAFE_INSTRUCTION_PATTERNS:
                match = pattern.search(line)
                if match is None:
                    continue
                prefix = line[: match.start()].rstrip()
                if cls._is_negated(prefix):
                    continue
                raise SkillPackageValidationError(
                    "unsafe_instruction",
                    "Skill 包包含未授权的执行或出站指令。",
                )

    @staticmethod
    def _is_negated(prefix: str) -> bool:
        return bool(
            _NEGATION_PATTERN.search(prefix)
            or _NEGATED_POLICY_PATTERN.search(prefix)
        )

    @staticmethod
    def _quality_warnings(description: str, content: str) -> tuple[str, ...]:
        warnings: list[str] = []
        if not any(
            hint.casefold() in description.casefold() for hint in _USAGE_HINTS
        ):
            warnings.append(
                "Skill description 建议说明适用场景和使用时机。"
            )
        non_empty_lines = tuple(line for line in content.splitlines() if line.strip())
        if len(non_empty_lines) < 3:
            warnings.append(
                "Skill 正文较短，建议补充适用场景、步骤、"
                "示例和边界。",
            )
        return tuple(warnings)

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

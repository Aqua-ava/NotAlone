"""与输入格式和持久化实现解耦的导入预览数据结构。"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ContactPreview:
    """从单联系人导出文件识别出的联系人。"""

    contact_id: str
    display_name: str
    display_name_variant_count: int


@dataclass(frozen=True, slots=True)
class ImportPreview:
    """完成整份文件校验后的只读预览结果。"""

    file_name: str
    content_sha256: str
    contact: ContactPreview
    record_count: int
    kind_counts: tuple[tuple[str, int], ...]

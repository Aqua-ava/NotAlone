"""与输入格式和持久化实现解耦的导入预览数据结构。

这些类只描述“校验成功后得到了什么”，不负责读取文件、校验字段或写数据库。
"""

from __future__ import annotations

from dataclasses import dataclass


# @dataclass 会根据下面声明的字段自动生成 __init__、__repr__ 和 __eq__。
# frozen=True 表示对象创建后不能重新给字段赋值，避免预览结果被后续代码悄悄修改。
# slots=True 表示对象只能拥有声明过的字段，同时减少内存占用和字段拼写错误。
@dataclass(frozen=True, slots=True)
class ContactPreview:
    """从单联系人导出文件识别出的联系人。"""

    # 微信 JSONL 导入时来自对方消息的 sender_wxid。
    contact_id: str
    # 按消息时间和行号选出的最新非空 sender，仅用于展示和人工核对。
    display_name: str
    # 同一 contact_id 在文件中出现过多少个不同的 sender 名称。
    display_name_variant_count: int


@dataclass(frozen=True, slots=True)
class ImportPreview:
    """完成整份文件校验后的只读预览结果。"""

    # 只保存文件的 basename，不把本机完整目录带入结果。
    file_name: str
    # 对原始文件字节计算的 SHA-256；预览默认不把具体值输出到终端。
    content_sha256: str
    # 已识别、仍需人工核对的候选联系人。
    contact: ContactPreview
    # JSONL 中通过校验的物理记录行数。
    record_count: int
    # 形如 (("image", 9), ("text", 143)) 的不可变消息类型统计。
    kind_counts: tuple[tuple[str, int], ...]

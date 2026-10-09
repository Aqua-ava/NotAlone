"""微信单联系人 JSONL 的确定性校验。

``_validate_record`` 检查一条记录本身；``validate_records`` 再检查整份文件是否只有
一个会话联系人。所有判断都由代码规则完成，不调用模型猜测身份。
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime
from typing import Any

from notalone.ingest.errors import ImportPreviewError
from notalone.ingest.models import (
    ChannelIdentityCandidate,
    OwnerChannelIdentityCandidate,
)

# frozenset 是不可修改的集合，适合保存运行期间不应改变的规则常量。
# 使用集合后，``kind in SUPPORTED_KINDS`` 可以直接判断某种消息是否受支持。
SUPPORTED_KINDS = frozenset(
    {
        "text",
        "quote",
        "image",
        "sticker",
        "transfer",
        "system",
        "voice",
        "voip",
        "video",
        "channel_video",
        "file",
        "link",
        "location",
        "miniprogram",
        "card",
        "red_packet",
        "forward_chat",
        "app",
    }
)
# 每条 JSONL 记录必须具备的顶层字段。做集合差集即可一次找出所有缺失字段。
REQUIRED_FIELDS = frozenset(
    {
        "id",
        "create_time",
        "is_from_me",
        "kind",
        "sender",
        "text",
        "time",
        "time_iso",
    }
)
# 原始 ``id`` 对象内部必须具备的字段。
REQUIRED_ID_FIELDS = frozenset({"local_id", "server_id_str", "talker"})
# 某些消息类型还需要专属载荷。值的结构是：(字段名, 期望的 Python 类型)。
OPTIONAL_PAYLOAD_TYPES = {
    "image": ("images", list),
    "quote": ("quote", dict),
    "transfer": ("transfer", dict),
}
# PostgreSQL bigint 是有符号 64 位整数，因此合法范围是 -2^63 到 2^63-1。
POSTGRES_BIGINT_MIN = -(2**63)
POSTGRES_BIGINT_MAX = 2**63 - 1


def validate_records(
    records: tuple[dict[str, Any], ...],
) -> tuple[
    OwnerChannelIdentityCandidate,
    ChannelIdentityCandidate,
    tuple[tuple[str, int], ...],
]:
    """校验所有记录并返回 owner、联系人身份候选和消息类型统计。

    ``records`` 表示一个 tuple，其中每个元素都是 ``dict[str, Any]``；``...`` 表示
    可以有任意数量的字典。

    返回值是一个三元 tuple：owner 身份候选、联系人身份候选和消息类型统计。类型标注主要
    供编辑器、静态检查和读代码的人使用；函数实现仍需主动遵守这个返回契约。
    """
    # 集合中的键由 local_id 和 create_time 组成，支持微信导出中的 local_id 循环复用。
    # 微信导出的 local_id 会循环复用，文件内唯一键是 (local_id, create_time)。
    message_keys: set[tuple[int, int]] = set()
    # 每项是 (create_time, JSONL 行号, sender)，用来确定最新展示名称。
    observed_names: list[tuple[int, int, str]] = []
    observed_owner_names: list[tuple[int, int, str]] = []
    # 收集对方消息中的 sender_wxid；最终集合大小必须恰好为 1。
    contact_external_ids: set[str] = set()
    # 收集本人消息中的 sender_wxid，检查是否混入另一个微信账号的数据。
    owner_sender_ids: set[str] = set()
    # 收集 id.talker；整份单联系人导出也只能出现一个。
    talker_ids: set[str] = set()
    # Counter() 创建计数器对象。Counter 只是类本身，不能代替这里的 Counter()。
    kind_counts: Counter[str] = Counter()

    # enumerate 每轮返回 (序号, 元素)；start=1 让序号与 JSONL 实际行号一致。
    for line_number, record in enumerate(records, start=1):
        # 先检查当前记录本身，失败会抛异常并停止整份文件的预览。
        _validate_record(record, line_number, message_keys)
        kind = record["kind"]
        # Counter 中尚不存在的键默认计数为 0，因此可以直接加 1。
        kind_counts[kind] += 1
        talker = record["id"]["talker"].strip()
        if talker.endswith("@chatroom"):
            raise ImportPreviewError("群聊资料必须拆分为单联系人后导入。")
        talker_ids.add(talker)

        # system 消息可能没有 sender_wxid，也不能用来判断联系人身份。
        if kind != "system":
            sender_id = _non_empty_string(record.get("sender_wxid"))
            if sender_id is None:
                raise ImportPreviewError(
                    f"第 {line_number} 行缺少有效的 sender_wxid。",
                    error_code="sender_identity_missing",
                    fields=("sender_wxid",),
                    rule="sender_identity",
                )
            # false 是联系人发来的消息；true 是当前用户发出的消息。
            if record["is_from_me"] is False:
                contact_external_ids.add(sender_id)
                observed_names.append(
                    (
                        record["create_time"],
                        line_number,
                        record["sender"].strip(),
                    )
                )
            else:
                owner_sender_ids.add(sender_id)
                observed_owner_names.append(
                    (
                        record["create_time"],
                        line_number,
                        record["sender"].strip(),
                    )
                )

    # 每条记录自身都合法后，再检查整份文件的身份是否一致。
    if len(talker_ids) != 1:
        raise ImportPreviewError(
            f"文件包含 {len(talker_ids)} 个 id.talker，必须拆分后导入。",
            error_code="contact_scope_mixed",
            fields=("id.talker",),
            rule="single_talker",
        )
    if not contact_external_ids:
        raise ImportPreviewError(
            "未找到可识别的联系人消息。",
            error_code="contact_identity_missing",
            fields=("sender_wxid", "is_from_me"),
            rule="contact_identity",
        )
    if len(contact_external_ids) != 1:
        raise ImportPreviewError(
            f"文件包含 {len(contact_external_ids)} 个联系人 sender_wxid，必须拆分后导入。",
            error_code="contact_scope_mixed",
            fields=("sender_wxid",),
            rule="single_contact_identity",
        )

    # 集合已经被证明只有一个元素：iter() 创建迭代器，next() 取出唯一值。
    contact_external_id = next(iter(contact_external_ids))
    talker_id = next(iter(talker_ids))
    if talker_id != contact_external_id:
        raise ImportPreviewError(
            "id.talker 与联系人 sender_wxid 不一致。",
            error_code="contact_identity_inconsistent",
            fields=("id.talker", "sender_wxid"),
            rule="talker_contact_match",
        )
    if not owner_sender_ids:
        raise ImportPreviewError(
            "未找到可识别的 owner sender_wxid。",
            error_code="owner_identity_missing",
            fields=("sender_wxid", "is_from_me"),
            rule="owner_identity",
        )
    if len(owner_sender_ids) > 1:
        raise ImportPreviewError(
            "本人发送消息包含多个 sender_wxid，无法确认单一账号范围。",
            error_code="owner_scope_mixed",
            fields=("sender_wxid", "is_from_me"),
            rule="single_owner_identity",
        )
    if contact_external_id in owner_sender_ids:
        raise ImportPreviewError(
            "本人发送身份与联系人 sender_wxid 冲突。",
            error_code="sender_identity_conflict",
            fields=("sender_wxid", "is_from_me"),
            rule="distinct_owner_contact",
        )

    # tuple 会依次比较各位置。max() 先选 create_time 最大者，时间相同时选行号最大者；
    # [2] 取三元组中的 sender。
    observed_name = max(observed_names)[2]
    # 集合推导式只保留不同昵称，len() 得到昵称变体数量。
    observed_name_variant_count = len({name for _, _, name in observed_names})
    observed_owner_name = max(observed_owner_names)[2]
    observed_owner_name_variant_count = len(
        {name for _, _, name in observed_owner_names}
    )

    # 返回恰好三个元素，与函数签名声明的返回类型一致。
    return (
        OwnerChannelIdentityCandidate(
            channel="wechat",
            external_id=next(iter(owner_sender_ids)),
            observed_name=observed_owner_name,
            observed_name_variant_count=observed_owner_name_variant_count,
        ),
        ChannelIdentityCandidate(
            channel="wechat",
            external_id=contact_external_id,
            observed_name=observed_name,
            observed_name_variant_count=observed_name_variant_count,
        ),
        # items() 产生 (kind, count)；sorted() 固定顺序；tuple() 使结果不可追加。
        tuple(sorted(kind_counts.items())),
    )


def _validate_record(
    record: dict[str, Any],
    line_number: int,
    message_keys: set[tuple[int, int]],
) -> None:
    """检查一条消息；合法时返回 ``None``，不合法时抛出异常。

    ``message_keys`` 是外层创建并反复传入的同一个集合，所以当前记录能知道前面已经
    使用过哪些消息标识。
    """
    # 集合差集：必需字段 - 当前实际字段 = 缺失字段。
    missing = sorted(REQUIRED_FIELDS - record.keys())
    if missing:
        raise ImportPreviewError(
            f"第 {line_number} 行缺少字段：{', '.join(missing)}。",
            error_code="required_field_missing",
            fields=tuple(missing),
            rule="required_fields",
        )

    # JSON 对象经 json.loads 解析后应当是 Python dict。
    message_id = record["id"]
    if not isinstance(message_id, dict):
        raise ImportPreviewError(
            f"第 {line_number} 行的 id 必须是对象。",
            error_code="field_type_invalid",
            fields=("id",),
            rule="id_object",
        )
    missing_id = sorted(REQUIRED_ID_FIELDS - message_id.keys())
    if missing_id:
        raise ImportPreviewError(
            f"第 {line_number} 行的 id 缺少字段：{', '.join(missing_id)}。",
            error_code="required_field_missing",
            fields=tuple("id." + field for field in missing_id),
            rule="required_id_fields",
        )

    local_id = message_id["local_id"]
    # bool 是 int 的子类；使用 type(...) is int 可以拒绝 True/False 冒充 ID。
    if type(local_id) is not int:
        raise ImportPreviewError(
            f"第 {line_number} 行的 id.local_id 必须是整数。",
            error_code="field_type_invalid",
            fields=("id.local_id",),
            rule="integer_field",
        )
    _validate_postgres_bigint(local_id, "id.local_id", line_number)

    create_time = record["create_time"]
    if type(create_time) is not int:
        raise ImportPreviewError(
            f"第 {line_number} 行的 create_time 必须是整数。",
            error_code="field_type_invalid",
            fields=("create_time",),
            rule="integer_field",
        )
    _validate_postgres_bigint(create_time, "create_time", line_number)

    # 先查重，再加入集合，供下一条记录继续检查。
    message_key = (local_id, create_time)
    if message_key in message_keys:
        raise ImportPreviewError(
            f"第 {line_number} 行的消息标识重复。",
            error_code="message_key_duplicate",
            fields=("id.local_id", "create_time"),
            rule="unique_message_key",
        )
    message_keys.add(message_key)

    # 两个字段使用同一规则，循环可以避免重复代码。
    for field in ("server_id_str", "talker"):
        if _non_empty_string(message_id[field]) is None:
            raise ImportPreviewError(
                f"第 {line_number} 行的 id.{field} 必须是非空字符串。",
                error_code="field_value_empty",
                fields=("id." + field,),
                rule="non_empty_id_string",
            )

    if type(record["is_from_me"]) is not bool:
        raise ImportPreviewError(
            f"第 {line_number} 行的 is_from_me 必须是布尔值。",
            error_code="field_type_invalid",
            fields=("is_from_me",),
            rule="boolean_field",
        )

    # 消息类型写入数据库枚举，必须精确匹配，不能静默接受首尾空白。
    kind = record["kind"]
    if not isinstance(kind, str) or kind not in SUPPORTED_KINDS:
        raise ImportPreviewError(
            f"第 {line_number} 行的 kind 不受支持。",
            error_code="message_kind_unsupported",
            fields=("kind",),
            rule="supported_kind",
        )

    # 这些字段内容可以不同，但 JSON 类型都必须是字符串。
    for field in ("sender", "text", "time", "time_iso"):
        if not isinstance(record[field], str):
            raise ImportPreviewError(
                f"第 {line_number} 行的 {field} 必须是字符串。",
                error_code="field_type_invalid",
                fields=(field,),
                rule="string_field",
            )

    if not record["sender"].strip():
        raise ImportPreviewError(
            f"第 {line_number} 行的 sender 不能为空。",
            error_code="field_value_empty",
            fields=("sender",),
            rule="non_empty_string",
        )
    if not record["time"].strip():
        raise ImportPreviewError(
            f"第 {line_number} 行的 time 不能为空。",
            error_code="field_value_empty",
            fields=("time",),
            rule="non_empty_string",
        )
    # 规范消息必须有正文或媒体占位；text 兼作媒体占位，空白 text
    # 必须在这里按行号拒绝，否则校验通过后会在规范化阶段抛出
    # 未处理的 ValueError，破坏"预览通过即可导入"的契约。
    if not record["text"].strip():
        raise ImportPreviewError(
            f"第 {line_number} 行的 text 不能为空。",
            error_code="field_value_empty",
            fields=("text",),
            rule="non_empty_string",
        )

    # fromisoformat 把 ISO 字符串解析成 datetime；解析失败时转成安全业务异常。
    try:
        occurred_at = datetime.fromisoformat(record["time_iso"])
    except ValueError:
        raise ImportPreviewError(
            f"第 {line_number} 行的 time_iso 不是有效 ISO 时间。",
            error_code="timestamp_invalid",
            fields=("time_iso",),
            rule="iso_timestamp",
        ) from None
    if occurred_at.tzinfo is None:
        raise ImportPreviewError(
            f"第 {line_number} 行的 time_iso 必须包含时区。",
            error_code="timestamp_timezone_missing",
            fields=("time_iso",),
            rule="timestamp_timezone",
        )
    if occurred_at.timestamp() != record["create_time"]:
        raise ImportPreviewError(
            f"第 {line_number} 行的 create_time 与 time_iso 不一致。",
            error_code="timestamp_inconsistent",
            fields=("create_time", "time_iso"),
            rule="timestamp_match",
        )

    # text/sticker/system 在映射中不存在，get() 返回 None，跳过专属载荷检查。
    optional_payload = OPTIONAL_PAYLOAD_TYPES.get(kind)
    if optional_payload is not None:
        # 把 (字段名, 类型) 这个二元 tuple 拆到两个变量。
        field, expected_type = optional_payload
        if field in record and not isinstance(record[field], expected_type):
            raise ImportPreviewError(
                f"第 {line_number} 行的 {kind} 消息的 {field} 类型无效。",
                error_code="field_type_invalid",
                fields=(field,),
                rule="media_payload_type",
            )
    if kind == "image":
        # 真实导出中附件路径可能缺失；占位文本已在 text 中，缺失不拒绝。
        images = record.get("images")
        if not images:
            images = []
        # 只检查结构和 path 类型，不打开 path 指向的任何本地文件。
        for image in images:
            if not isinstance(image, dict):
                raise ImportPreviewError(
                    f"第 {line_number} 行的 images 元素必须是对象。",
                    error_code="field_type_invalid",
                    fields=("images[]",),
                    rule="image_object",
                )
            if "path" in image and not isinstance(image["path"], str):
                raise ImportPreviewError(
                    f"第 {line_number} 行的 images.path 必须是字符串。",
                    error_code="field_type_invalid",
                    fields=("images[].path",),
                    rule="image_path_string",
                )


def _non_empty_string(value: object) -> str | None:
    """非空字符串去掉首尾空白后返回；其他输入返回 ``None``。"""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _validate_postgres_bigint(
    value: int, field: str, line_number: int
) -> None:
    """确认整数能写入 PostgreSQL bigint，并在错误中指出字段和行号。"""
    if not POSTGRES_BIGINT_MIN <= value <= POSTGRES_BIGINT_MAX:
        raise ImportPreviewError(
            f"第 {line_number} 行的 {field} 超出 PostgreSQL bigint 范围。",
            error_code="numeric_out_of_range",
            fields=(field,),
            rule="postgres_bigint",
        )

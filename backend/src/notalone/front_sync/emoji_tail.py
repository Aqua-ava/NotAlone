"""完整名称的保守简单 emoji 尾缀；不猜测未知 Unicode 序列。"""

from notalone.front_sync.emoji_presentation_data import EMOJI_PRESENTATION_RANGES


def has_supported_emoji_suffix(full_name: str, prefix: str) -> bool:
    """保留前缀的每个字符，只接受默认 emoji 及其可选单次 VS16。"""

    if not prefix or not full_name.startswith(prefix):
        return False
    suffix = full_name[len(prefix):]
    if not suffix:
        return False
    index = 0
    while index < len(suffix):
        scalar = ord(suffix[index])
        if (0x1F1E6 <= scalar <= 0x1F1FF or 0x1F3FB <= scalar <= 0x1F3FF
                or not any(start <= scalar <= end for start, end in EMOJI_PRESENTATION_RANGES)):
            return False
        index += 1
        if index < len(suffix) and suffix[index] == "\ufe0f":
            index += 1
    return True

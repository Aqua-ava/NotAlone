"""仅修复可确定的JSON语法，不补全截断正文或猜测字段值。"""
import json
import re


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('重复JSON键不能安全修复。')
        result[key] = value
    return result


def _invalid_constant(value):
    raise ValueError('非有限JSON数字不能安全修复。')


def parse_arguments(raw: str, *, field_names: frozenset[str]) -> tuple[dict, bool]:
    """最多八处语法修复；原始响应仍由追踪保存。"""
    try:
        parsed = json.loads(raw, object_pairs_hook=_unique, parse_constant=_invalid_constant)
        if not isinstance(parsed, dict):
            raise ValueError('提取参数必须是JSON对象。')
        return parsed, False
    except json.JSONDecodeError:
        pass
    value = raw.strip()
    if value.startswith('```json\n') and value.endswith('```'):
        value = value[8:-3].strip()
    elif value.startswith('```\n') and value.endswith('```'):
        value = value[4:-3].strip()
    for attempt in range(9):
        try:
            parsed = json.loads(value, strict=False, object_pairs_hook=_unique,
                                parse_constant=_invalid_constant)
            if not isinstance(parsed, dict):
                raise ValueError('提取参数必须是JSON对象。')
            return parsed, True
        except json.JSONDecodeError as error:
            if attempt == 8:
                raise
            pos = error.pos
            # 只在解析器明确要求对象键的位置补已知字段的起始引号。
            match = re.match(r'([A-Za-z_][A-Za-z_0-9]*)"\s*:', value[pos:])
            if error.msg == 'Expecting property name enclosed in double quotes' and match and match[1] in field_names:
                value = value[:pos] + '"' + value[pos:]
                continue
            # 仅删除关闭括号前的结构性尾逗号；不扫描或改写字符串内部。
            prefix = value[:pos].rstrip()
            if (value[pos:pos+1] in ('}', ']') and prefix.endswith(',')
                    and error.msg in ('Expecting value', 'Expecting property name enclosed in double quotes')):
                value = prefix[:-1] + value[pos:]
                continue
            raise
    raise ValueError('JSON修复次数耗尽。')

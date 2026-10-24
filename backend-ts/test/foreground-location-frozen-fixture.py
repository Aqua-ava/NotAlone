"""从冻结旧实现的现有合成用例提取定位合同，不读取业务资料。"""
import io
from copy import deepcopy
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FILES = [
    "backend/src/notalone/front_sync/foreground_locator.py",
    "backend/src/notalone/front_sync/probe_adapter.py",
    "backend/src/notalone/front_sync/name_matching.py",
    "backend/tests/unit/front_sync/test_emoji_fallback.py",
    "backend/tests/unit/front_sync/test_name_match_locator.py",
]
for name in FILES:
    frozen = subprocess.check_output(["git", "show", "3c168296e9e8edaa43b8b323ff693e790e709069:" + name], cwd=ROOT)
    if frozen != (ROOT / name).read_bytes():
        raise RuntimeError("冻结定位基线已变化，不能冒充差分参考")

from tests.unit.front_sync import test_emoji_fallback as fixtures
from tests.unit.front_sync.test_name_match_locator import NameMatchLocatorTest

original = fixtures.EmojiFallbackTest.locate
vectors = []


def capture(self, payload=None, **kwargs):
    result = original(self, payload, **kwargs)
    if any(kwargs.get(key) is not None for key in ("cli_error", "check_current", "deadline")) or result.phase == "unavailable":
        return result
    parsed = self.parse(fixtures.envelope() if payload is None else payload)
    q, tail = parsed.quality, parsed.text_fallback
    observation = {
        "wechat_in_front": parsed.wechat_in_front,
        "display_name": parsed.evidence.display_name if parsed.evidence else None,
        "capture_version": q.capture_version if q else (payload or {}).get("capture_version"),
        "selected_row_name": parsed.selected_row_name,
        "quality": None if q is None else {
            "layout_verified": True, "display_name_confidence": q.display_name_confidence,
            "name_complete": q.name_complete, "selected_row_name_confidence": q.selected_row_name_confidence,
        },
        "text_fallback": None if tail is None else {
            "version": tail.version, "text": tail.text, "confidence": tail.confidence,
            "text_complete": tail.text_complete, "mask_verified": tail.mask_verified,
        },
    }
    candidates = kwargs.get("candidates")
    bindings = kwargs.get("bindings")
    vectors.append(deepcopy({
        "observation": observation,
        "sessions": [{"username": row.username, "display_name": row.display_name, "chat_type": row.chat_type}
                     for row in ((fixtures.candidate(),) if candidates is None else candidates)],
        "bindings": [{"binding_id": str(row.binding_id), "owner_id": str(row.scope.owner_id),
                      "contact_id": str(row.scope.contact_id), "channel": row.channel,
                      "account_scope": row.account_scope, "conversation_locator": row.conversation_locator,
                      "display_name": row.display_name, "status": row.status.value}
                     for row in ((fixtures.binding(),) if bindings is None else bindings)],
        "expected": {key: str(value) if key in ("binding_id", "contact_id") and value is not None else value
                     for key in ("phase", "reason", "probe_available", "wechat_in_front", "binding_id", "contact_id", "recognized_name", "recognition_confidence")
                     for value in (getattr(result, key),)},
    }))
    return result


fixtures.EmojiFallbackTest.locate = capture
NameMatchLocatorTest.locate = capture
suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(fixtures.EmojiFallbackTest),
                           unittest.defaultTestLoader.loadTestsFromTestCase(NameMatchLocatorTest)])
result = unittest.TextTestRunner(stream=io.StringIO()).run(suite)
if not result.wasSuccessful():
    raise RuntimeError("冻结参考合成用例未通过")
print(json.dumps(vectors, ensure_ascii=False))

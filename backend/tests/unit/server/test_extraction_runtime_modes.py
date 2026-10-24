"""提取宿主只接受明确的 A/B 运行方式组合。"""

import unittest

from notalone.server.command import _extraction_runtime_modes


class ExtractionRuntimeModesTest(unittest.TestCase):
    def test_b_typescript_requires_typescript_a_and_known_values(self):
        self.assertEqual(
            _extraction_runtime_modes({}),
            ("python", "python"),
        )
        self.assertEqual(
            _extraction_runtime_modes({
                "NOTALONE_EXTRACTION_RUNTIME": "typescript",
                "NOTALONE_EXTRACTION_B_RUNTIME": "typescript",
            }),
            ("typescript", "typescript"),
        )
        self.assertEqual(
            _extraction_runtime_modes({
                "NOTALONE_EXTRACTION_RUNTIME": "typescript",
            }),
            ("typescript", "python"),
        )
        for environment in (
            {"NOTALONE_EXTRACTION_B_RUNTIME": "typescript"},
            {
                "NOTALONE_EXTRACTION_RUNTIME": "typescript",
                "NOTALONE_EXTRACTION_B_RUNTIME": "unknown",
            },
            {"NOTALONE_EXTRACTION_RUNTIME": "unknown"},
        ):
            with self.subTest(environment=environment):
                with self.assertRaises(ValueError):
                    _extraction_runtime_modes(environment)

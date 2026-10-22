"""核验保真档保持旧合同，且不允许混入证明协议。"""
from __future__ import annotations

import hashlib
import unittest

from notalone.memory_extraction.verification_adapters import source_verification_contract


class VerificationRetentionProfileTest(unittest.TestCase):
    def test_retention_uses_same_four_slots_and_keeps_existing_profiles_frozen(self):
        default, schema = source_verification_contract('legacy-v4')
        quote, quote_schema = source_verification_contract(
            'legacy-v4', prompt_profile='public-author-quote-v1',
        )
        self.assertEqual(hashlib.sha256(default.encode()).hexdigest(),
                         'e36a8b03e714284f217b30c56c0fa09f66bb8cf4bfe705db9e3c102e749b2b8b')
        self.assertEqual(hashlib.sha256(quote.encode()).hexdigest(),
                         '4e9db1bfdfd61f98a11570509f893db08d49cc409ada3b717d0664210fd0a333')
        prompt, retained_schema = source_verification_contract(
            'legacy-v4', prompt_profile='reference-retention-v1',
        )
        self.assertTrue(prompt.startswith(quote))
        self.assertNotEqual(prompt, quote)
        self.assertEqual(retained_schema, schema)
        self.assertEqual(quote_schema, schema)

    def test_retention_cannot_enable_proof_modes(self):
        for mode in ('nullable-proof-v1', 'nullable-proof-v2', 'nullable-proof-v3'):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                source_verification_contract(mode, prompt_profile='reference-retention-v1')

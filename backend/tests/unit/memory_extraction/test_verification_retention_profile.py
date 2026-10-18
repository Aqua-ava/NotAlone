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
                         '30eaf682a996ca988358c60e1ef9033841738b72edba0f8a5187d430f0c76a07')
        self.assertEqual(hashlib.sha256(quote.encode()).hexdigest(),
                         '5b84071c341f57b261e504a4247a1964b70a3fa03fdff974d98eb4985e498f5c')
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

"""批准身份来自实际运行协议、规则和配置；旧未知不能补签。"""

from copy import deepcopy
import unittest

from notalone.memory.upgrade import UpgradeConflict
from notalone.memory.upgrade_algorithm import require_upgrade_algorithm
from notalone.memory_extraction.dimensions import DimensionRelease
from tests.unit.memory_extraction.upgrade_helpers import synthetic_upgrade_algorithm


class UpgradeAlgorithmTest(unittest.TestCase):
    def test_actual_direct_verifier_and_effective_configuration_are_bound(self):
        current = synthetic_upgrade_algorithm()
        require_upgrade_algorithm(current, synthetic_upgrade_algorithm())
        self.assertEqual(current['protocol'], 'direct_scene_memory_v1')
        self.assertEqual(current['compiler'], '1')
        self.assertEqual(current['verification_mode'], 'legacy-v4')
        self.assertEqual(current['configuration']['max_retries'], 0)
        self.assertEqual(current['configuration']['tool_choice'], 'omitted')
        self.assertEqual(current['configuration']['dimension_allowed'], [])
        for changed in (synthetic_upgrade_algorithm(model_name='synthetic-upgrade-next'),
                        synthetic_upgrade_algorithm(release=DimensionRelease(gate_enabled=False))):
            with self.assertRaises(UpgradeConflict):
                require_upgrade_algorithm(current, changed)

    def test_old_unknown_or_forged_identity_is_never_upgraded(self):
        current = synthetic_upgrade_algorithm()
        changed = deepcopy(current)
        changed['configuration']['tool_choice'] = 'named'
        for old in (None, {}, {'version': 1}, {**current, 'version': True}, changed):
            with self.subTest(old=old):
                with self.assertRaises(UpgradeConflict):
                    require_upgrade_algorithm(old, current)

"""公开评测运行的单场景有限执行；直接复用整理提案/核验Port与结构合同。"""

from notalone.memory.organization_isolation import isolate_proposal, select_verified
from copy import deepcopy
from types import SimpleNamespace
from notalone.memory.layered_correction_validation import validate_correction_proposal
from notalone.application.organization_call import bounded_organization_call, require_adapter_timeout_contract
from notalone.application.model_priority import ModelPriorityControl
from notalone.memory.layered import OrganizationBudgetExhausted
from notalone.memory.owner_organization_input import organization_model_memories, organization_model_scenarios
from notalone.scopes import organization_scope
from notalone.memory.scenario_validation import validate_proposal
from notalone.memory.profile_validation import validate_profile
from notalone.memory.organization_quality_transport import evaluation_request_context, OrganizationRequestBudgetExceeded


class OrganizationEvaluationRuntime:
    def __init__(self, *, scenario_proposer, scenario_verifier, profile_proposer, profile_verifier,
                 model_priority=None, call_timeout_seconds=30, suite_budget=None, source_ref=None):
        self.ports = (scenario_proposer, scenario_verifier, profile_proposer, profile_verifier)
        if scenario_proposer is scenario_verifier or profile_proposer is profile_verifier:
            raise ValueError('提案与忠实度核验必须独立装配。')
        for adapter, operation in zip(self.ports, ('propose', 'verify', 'propose', 'verify')):
            require_adapter_timeout_contract(adapter, operation, synthetic=False)
        if type(call_timeout_seconds) not in {int, float} or not 0 < call_timeout_seconds <= 30:
            raise ValueError('单阶段评测须有不超过30秒的实际期限。')
        self.priority = model_priority or ModelPriorityControl()
        self.timeout_seconds = call_timeout_seconds
        self.suite_budget, self.source_ref = suite_budget, source_ref

    @property
    def transport_kind(self):
        from notalone.memory.organization_sdk import actual_organization_adapters
        return 'sdk' if actual_organization_adapters(self.ports) else 'synthetic'

    def execute_next(self, store, owner_id, run_id, contract, *, allow_unreviewed_smoke=False):
        if self.transport_kind == 'sdk' and (self.suite_budget is None or not self.source_ref):
            raise RuntimeError('实际候选须显式装配同一持久suite总额度。')
        case = store.claim_case(owner_id, run_id, contract, transport_kind=self.transport_kind,
                                allow_unreviewed_smoke=allow_unreviewed_smoke)
        if case is None:
            return
        scope = organization_scope(owner_id, case['contact_id'])
        l2_context = tuple(case['model_input']['scenarios'])
        l3_context = ()
        l3_raw_memories = ()
        corrections = tuple(case['model_input'].get('corrections', []))
        output = {}
        phase = 'preparation'
        try:
            for phase, adapter, operation, layer in (
                    ('l2_proposal', self.ports[0], 'propose', 'l2'),
                    ('l2_verification', self.ports[1], 'verify', 'l2'),
                    ('l3_proposal', self.ports[2], 'propose', 'l3'),
                    ('l3_verification', self.ports[3], 'verify', 'l3'),
                    ('l2_challenge', self.ports[1], 'verify', 'l2'),
                    ('l3_challenge', self.ports[3], 'verify', 'l3')):
                if layer == 'l3' and not phase.endswith('challenge') and not l3_context:
                    if phase == 'l3_proposal':
                        output['l3'] = {'entries': []}
                        store.record_stage(owner_id, case['id'], case['execution_token'], 'l3', output['l3'])
                        store.record_stage(owner_id, case['id'], case['execution_token'], 'l3_not_required', True)
                    continue
                challenge = (case['annotations'] or {}).get('verifier_challenges', {}).get(layer) if phase.endswith('challenge') else None
                if phase.endswith('challenge') and challenge is None:
                    store.record_stage(owner_id, case['id'], case['execution_token'], phase, None,
                                       finished=phase == 'l3_challenge')
                    continue
                if operation == 'verify' and callable(getattr(adapter, 'verify_items', None)):
                    operation = 'verify_items'
                context = l2_context if layer == 'l2' else l3_context
                raw_memories = case['memories'] if layer == 'l2' or challenge else l3_raw_memories
                phase_memories = organization_model_memories(scope, raw_memories)
                kwargs = {'memories': deepcopy(phase_memories), 'scenarios': deepcopy(context), 'corrections': deepcopy(corrections)}
                if operation == 'propose':
                    kwargs['budget'] = contract.budget
                else:
                    kwargs['proposal'] = deepcopy(challenge['proposal'] if challenge else output[layer])
                    if challenge:
                        (validate_proposal(kwargs['proposal'], raw_memories, contract.budget, scenarios=l2_context)
                         if layer == 'l2' else validate_profile(kwargs['proposal'], raw_memories, contract.budget))
                        store.record_challenge_input(owner_id, case['id'], case['execution_token'], phase,
                            {'layer': layer, 'memories': [item.to_payload() for item in phase_memories], 'scenarios': list(context),
                             'corrections': list(corrections), 'proposal': kwargs['proposal']})

                def call(deadline):
                    with evaluation_request_context(store, owner_id, run_id, case, phase, deadline, contract.budget,
                            suite_budget=self.suite_budget, source_ref=self.source_ref):
                        return getattr(adapter, operation)(**kwargs, deadline=deadline)
                value = bounded_organization_call(call, priority=self.priority,
                    guard=lambda: store.check_execution(owner_id, case['id'], case['execution_token']),
                    timeout_seconds=self.timeout_seconds)
                key = 'scenarios' if layer == 'l2' else 'entries'
                def validate_items(payload):
                    normalized = (validate_proposal(payload, raw_memories, contract.budget, scenarios=l2_context)
                        if layer == 'l2' else validate_profile(payload, raw_memories, contract.budget))
                    validate_correction_proposal(SimpleNamespace(memories=raw_memories, corrections=corrections), normalized, profile=layer == 'l3')
                    return normalized
                if operation == 'propose':
                    filtered, normalized, rejected = isolate_proposal(value, key, validate_items,
                        contract.budget.max_scenarios if layer == 'l2' else contract.budget.max_profile_entries)
                    store.record_stage(owner_id, case['id'], case['execution_token'], phase + '_isolation',
                        {'original': value, 'rejected': rejected})
                    output[layer] = filtered
                    store.record_stage(owner_id, case['id'], case['execution_token'], layer, filtered)
                    if value[key] and not filtered[key]:
                        raise ValueError('所有候选均未通过结构或纠错检查。')
                else:
                    filtered, rejected = select_verified(kwargs['proposal'], key, value)
                    passed = verification_passed(kwargs['proposal'], key, value, challenge=bool(challenge))
                    error = None if passed else ('verifier_false_accept' if challenge else 'faithfulness_rejected')
                    store.record_stage(owner_id, case['id'], case['execution_token'], phase + '_isolation',
                        {'verdict': value, 'rejected': rejected})
                    if not challenge and passed:
                        normalized = validate_items(filtered)
                        output[layer] = filtered
                        store.record_stage(owner_id, case['id'], case['execution_token'], layer, filtered)
                    store.record_stage(owner_id, case['id'], case['execution_token'], phase,
                        not passed if challenge else passed, error_code=error, finished=phase == 'l3_challenge')
                    if error:
                        return
                    if layer == 'l2' and not challenge:
                        l3_raw_memories, l3_context = store.checkpoint_l2(owner_id, case, normalized, contract.budget)
        except (LookupError, PermissionError):
            return
        except Exception as error:
            code = ('physical_attempt_budget_exhausted' if isinstance(error, OrganizationBudgetExhausted)
                    else 'actual_request_budget_exceeded' if isinstance(error, OrganizationRequestBudgetExceeded)
                    else 'evaluation_stage_invalid' if isinstance(error, ValueError) else 'evaluation_stage_failed')
            try:
                store.record_stage(owner_id, case['id'], case['execution_token'], phase + '_error', code,
                                   error_code=code)
            except (LookupError, PermissionError):
                pass


def verification_passed(proposal, key, verdict, *, challenge=False):
    """坏例挑战要求全部拒绝；不能将部分放行误算挑战通过。"""
    filtered, _ = select_verified(proposal, key, verdict)
    if challenge:
        return not filtered[key] and verdict is not True
    return verdict is not False and (not proposal[key] or bool(filtered[key]))

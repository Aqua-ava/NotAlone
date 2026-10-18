"""质量结论由完整证据推导；失败分母、未知审阅与两个阶段各自保留。"""

from collections import Counter
from datetime import datetime, timedelta, timezone
from notalone.memory.organization_quality import content_digest, FACT_PREPARATION_DATASET_VERSION

SEMANTIC_DIMENSIONS = frozenset({'subject', 'negation', 'time', 'plan', 'condition', 'conflict', 'correction', 'stability'})
REQUIRED_PHASES = frozenset({'l2_proposal', 'l2_verification', 'l3_proposal', 'l3_verification', 'l2_challenge', 'l3_challenge'})


def human_approved(review):
    return bool(review and review.get('reviewer', {}).get('kind') == 'human'
                and review.get('reviewer', {}).get('name', '').strip() and review.get('decision') == 'approved')


def output_items(output):
    """涵盖所有生成正文与目录文字，逐项审阅不只核ID存在。"""
    if not output:
        return []
    result = []
    for i, scenario in enumerate(output.get('l2', {}).get('scenarios', [])):
        refs = [ref for paragraph in scenario['paragraphs'] for ref in paragraph['references']]
        for name in ('title', 'hint'):
            result.append({'path': f'/l2/scenarios/{i}/{name}', 'text': scenario[name], 'references': refs})
        for j, paragraph in enumerate(scenario['paragraphs']):
            result.append({'path': f'/l2/scenarios/{i}/paragraphs/{j}', **paragraph})
    for i, entry in enumerate(output.get('l3', {}).get('entries', [])):
        result.append({'path': f'/l3/entries/{i}', **entry})
    return result


def model_evidence_reasons(attempts, contract):
    """同一可观测候选必须覆盖完整集合；浮动别名不能混合多份子资格。"""
    reasons, observed = [], {}
    for attempt in attempts:
        request = attempt.get('request_model')
        expected = contract.get('request_model' if attempt['phase'].endswith('proposal') else 'verifier_model')
        response, route = attempt.get('response_model'), attempt.get('request_route')
        if request != expected:
            reasons.append('candidate_model_changed')
        if not request or not response or route in {None, '', 'unknown'}:
            reasons.append('actual_model_identity_unknown')
        identity = (response, attempt.get('system_fingerprint'), route)
        if request in observed and observed[request] != identity:
            reasons.append('candidate_model_changed')
        observed[request] = identity
    return list(dict.fromkeys(reasons))


def l3_not_applicable(case):
    checkpoint = case.get('stage_evidence', {}).get('l3_checkpoint', {})
    output = case['output_payload'] or {}
    return (checkpoint.get('kind') == 'evaluation_checkpoint' and checkpoint.get('normal_call_required') is False
        and checkpoint.get('documents') == [] and output.get('l3_not_required') is True
        and output.get('l2') == {'scenarios': []} and output.get('l3') == {'entries': []})


def required_case_phases(case):
    if l3_not_applicable(case) and (case.get('annotations') or {}).get('empty_support_policy') in {'reject', 'uncertain_summary_allowed'}:
        return REQUIRED_PHASES - {'l3_proposal', 'l3_verification'}
    return REQUIRED_PHASES


def observed_maximum(attempts, key):
    values = [(item.get('measurements') or {}).get(key) for item in attempts]
    return max(values) if values and all(type(value) is int for value in values) else None


def build_quality_report(run, cases, attempts, current_contract_id):
    from notalone.memory.organization_quality_review import output_review
    def complete_output_review(case):
        if not human_approved(case['output_review']) or case['execution_state'] not in {'complete', 'failed'}:
            return False
        try:
            output_review(case['output_review'], case)
        except (ValueError, RuntimeError):
            return False
        return case['output_review'].get('verifier_challenges_reviewed') is True
    reasons, failures = [], []
    if run['contract_id'] != current_contract_id:
        reasons.append('contract_changed')
    if run['state'] != 'complete' or len(cases) != run['case_count'] or any(c['execution_state'] != 'complete' for c in cases):
        reasons.append('evaluation_incomplete')
    if not run['input_review_frozen'] or not cases or any(not human_approved(case['annotations']) for case in cases):
        reasons.append('human_annotations_missing')
    dimensions = Counter(case['annotations']['dimension'] for case in cases if human_approved(case['annotations']))
    independent = {case['annotations'].get('scenario_key') for case in cases if human_approved(case['annotations'])}
    if any(dimensions[name] < 15 for name in SEMANTIC_DIMENSIONS) or len(independent) != len(cases):
        reasons.append('coverage_insufficient')
    if not cases or any(not complete_output_review(case) for case in cases):
        reasons.append('human_output_review_missing')
    if (run['transport_kind'] != 'sdk' or not attempts
            or any(a['outcome'] != 'succeeded' or not a['response_model'] or a.get('request_route', 'unknown') == 'unknown' for a in attempts)
            or any({a['phase'] for a in attempts if a['case_id'] == case['id']} != required_case_phases(case) for case in cases)):
        reasons.append('actual_model_evidence_missing')
    if run['transport_kind'] == 'sdk':
        reasons.extend(model_evidence_reasons(attempts, run['contract']))
    if not human_approved(run['calibration']):
        reasons.append('budget_calibration_missing')
    for case in cases:
        review = case['output_review'] or {}
        if (review and review.get('projection_passed') is not True):
            reasons.append('scope_projection_failed')
        if review.get('decision') == 'rejected' or any(item.get('critical_errors') or item.get('supported') is not True for item in review.get('claims', [])):
            reasons.append('critical_semantic_errors')
        if case['error_code']:
            failures.append({'case_id': str(case['id']), 'error_code': case['error_code']})
    if run['http_attempts_used'] >= run['max_http_attempts'] and run['state'] != 'complete':
        reasons.append('physical_attempt_budget_exhausted')
    if failures:
        reasons.append('evaluation_failed')
    reasons = list(dict.fromkeys(reasons))
    failed = bool(failures or any(reason in reasons for reason in ('critical_semantic_errors', 'scope_projection_failed')))
    status = 'failed' if failed else 'unknown' if reasons else 'verified'
    stage = {'status': status, 'reasons': reasons, 'contract_id': current_contract_id, 'report_id': str(run['id'])}
    phase_counts = {}
    for phase in sorted(REQUIRED_PHASES):
        phase_attempts = [a for a in attempts if a['phase'] == phase]
        output_key = {'l2_proposal': 'l2', 'l3_proposal': 'l3'}.get(phase, phase)
        not_applicable = sum(l3_not_applicable(case) for case in cases) if phase in {'l3_proposal', 'l3_verification'} else 0
        executed = sum((any(a['case_id'] == case['id'] for a in phase_attempts)
            or (case['output_payload'] or {}).get(output_key) is not None)
            and not (phase in {'l3_proposal', 'l3_verification'} and l3_not_applicable(case)) for case in cases)
        phase_counts[phase] = {'case_denominator': run['case_count'], 'executed_cases': executed,
            'not_run_cases': run['case_count'] - executed - not_applicable, 'not_applicable_cases': not_applicable, 'http_attempts': len(phase_attempts),
            'failed_http_attempts': sum(a['outcome'] != 'succeeded' for a in phase_attempts)}
    output_lengths = [len(item['text']) for case in cases for item in output_items(case['output_payload'])]
    usages = [(a['response_payload'] or {}).get('usage') for a in attempts]
    token_usage = {key: sum(item[key] for item in usages) if usages and all(isinstance(item, dict)
                    and type(item.get(key)) is int for item in usages) else None
                   for key in ('prompt_tokens', 'completion_tokens', 'total_tokens')}

    return {'schema_version': 2, 'report_id': str(run['id']), 'stage': run['stage'], 'contract_id': run['contract_id'],
            'contract': run['contract'], 'dataset_version': run['dataset_version'], 'dataset_sha256': run['dataset_sha256'],
            'data_kind': run['data_kind'], 'state': run['state'], 'case_count': run['case_count'],
            'reviewed_case_count': sum(complete_output_review(case) for case in cases),
            'dimensions': dict(dimensions), 'failure_count': len(failures), 'failures': failures,
            'phase_counts': phase_counts, 'token_usage': token_usage,
            'http_attempts_used': run['http_attempts_used'], 'max_http_attempts': run['max_http_attempts'],
            'transport_kind': run['transport_kind'], 'input_review_frozen': run['input_review_frozen'],
            'input_review_sha256': run['input_review_sha256'], 'organization': stage,
            'automatic_use_allowed': False,
            'preparation': ({'purpose': 'fact_correction_path', 'state': ('armed'
                if run['created_at'] + timedelta(minutes=30) > datetime.now(timezone.utc) else 'expired'),
                'origin_run_id': str(run['id']), 'origin_case_id': str(cases[0]['id']),
                'old_memory_id': cases[0]['input_manifest'][0]['memory_id'],
                'old_revision': cases[0]['input_manifest'][0]['revision'],
                'settings_generation': cases[0]['settings_generation'],
                'human_review': False, 'quality_verified': False,
                'registration_expires_at': (run['created_at'] + timedelta(minutes=30)).isoformat()}
                if run['dataset_version'] == FACT_PREPARATION_DATASET_VERSION and len(cases) == 1 else None),
            'calibration': {'review': run['calibration'], 'observed_max_output_item_characters': max(output_lengths, default=0),
                'observed_max_request_characters': observed_maximum(attempts, 'request_entity_characters'),
                'observed_max_response_entity_characters': observed_maximum(attempts, 'response_entity_characters'),
                'observed_max_generated_content_characters': observed_maximum(attempts, 'generated_content_characters'),
                'estimated_max_request_json_characters': max((len(__import__('json').dumps(a['request_payload'], ensure_ascii=False, separators=(',', ':'))) for a in attempts), default=None),
                'observed_max_input_characters': max((len(__import__('json').dumps(c['model_input'], ensure_ascii=False)) for c in cases), default=0),
                'observed_max_memories': max((len(c['model_input']['memories']) for c in cases), default=0)},
            'cases': [{'case_id': str(c['id']), 'input_sha256': c['input_sha256'], 'model_input': c['model_input'],
                       'stage_evidence': c.get('stage_evidence', {}), 'construction': c['construction'], 'guard_snapshot': c['guard_snapshot'], 'annotations': c['annotations'], 'output': c['output_payload'],
                       'output_sha256': content_digest(c['output_payload']) if c['output_payload'] is not None else None,
                       'review_items': output_items(c['output_payload']), 'output_review': c['output_review'],
                       'execution_state': c['execution_state'], 'error_code': c['error_code']} for c in cases],
            'attempts': [{**{k: a[k] for k in ('ordinal', 'phase', 'outcome', 'request_model', 'response_model',
                        'system_fingerprint', 'request_payload', 'response_payload', 'duration_ms', 'request_route', 'measurements')},
                         'case_id': str(a['case_id']), 'underlying_model_version': 'unknown'} for a in attempts]}

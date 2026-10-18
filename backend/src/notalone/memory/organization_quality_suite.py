"""自有_test源的完整合成suite：live复验、全局标定与无正文资格回执。"""

from collections import Counter
from urllib.parse import urlsplit

from notalone.memory.organization_quality import content_digest
from notalone.memory.organization_quality_report import build_quality_report, human_approved, SEMANTIC_DIMENSIONS


def contract_identity(contract):
    return contract if isinstance(contract, str) else contract.identity


def feedback_snapshot_matches(fixture, case):
    corrections = case['model_input'].get('corrections')
    guard = case.get('guard_snapshot')
    if (not isinstance(corrections, list) or not isinstance(guard, dict)
            or set(guard) != {'correction_revision', 'organization_generation', 'feedback_targets', 'fact_pending'}
            or type(guard['correction_revision']) is not int or guard['correction_revision'] < 0
            or type(guard['organization_generation']) is not int or guard['organization_generation'] < 0
            or not isinstance(guard['feedback_targets'], list)):
        return False
    if fixture['feedback_mode'] in {'baseline', 'fact_corrected'}:
        return corrections == [] and guard['feedback_targets'] == [] and guard['fact_pending'] == []
    if not corrections:
        return False
    targets = {}
    for target in guard['feedback_targets']:
        if (not isinstance(target, dict) or set(target) != {'feedback_id', 'target_kind', 'version_id', 'item_index',
                'state', 'protected_memory_ids', 'protected_message_ids'}
                or target['target_kind'] not in {'scenario', 'profile'}
                or target['state'] not in {'active', 'erased_guard'} or target['feedback_id'] in targets):
            return False
        targets[target['feedback_id']] = target
    observed = set()
    for correction in corrections:
        if (not isinstance(correction, dict) or set(correction) != {'feedback_id', 'rejected_text', 'reason', 'rule'}
                or correction['rule'] != 'independent-literal-v1'
                or correction['feedback_id'] not in targets
                or targets[correction['feedback_id']]['state'] != 'active'):
            return False
        observed.add(targets[correction['feedback_id']]['target_kind'])
    return observed == {'scenario' if fixture['feedback_layer'] == 'l2' else 'profile'}


def fact_correction_matches(fixture, case):
    versions = {item['memory_id']: item['revision'] for item in case['input_manifest']}
    facts = case.get('stage_evidence', {}).get('fact_corrections', [])
    expected_kind = 'owner_memory' if fixture['scope_kind'] == 'owner' else 'contact_memory'
    command = fixture.get('fact_error_command')
    if not isinstance(command, dict):
        return False
    def actual_receipt(item):
        receipt = item.get('fact_error_receipt')
        return (isinstance(receipt, dict) and receipt.get('state') == 'consumed'
            and receipt.get('request_digest') == content_digest(command)
            and receipt.get('old_memory_id') == command.get('memory_id') == item.get('record_id')
            and receipt.get('settings_generation') == command.get('settings_generation')
            and receipt.get('decision_id') == item.get('decision_id')
            and receipt.get('replacement_memory_id') == item.get('replacement_memory_id')
            and command.get('target_kind') == ('scenario' if fixture['feedback_layer'] == 'l2' else 'profile'))
    return bool(facts) and all(item.get('record_kind') == expected_kind
        and item.get('replacement_memory_id') in versions
        and item.get('replacement_revision') == versions[item['replacement_memory_id']]
        and item['replacement_revision'] >= 2 and actual_receipt(item) for item in facts)


def model_identities(attempts):
    values = {}
    def label(value):
        return value if isinstance(value, str) and 0 < len(value) <= 300 else 'unknown'
    for attempt in attempts:
        request = attempt.get('request_payload')
        request = request if isinstance(request, dict) else {}
        response = attempt.get('response_payload')
        response = response if isinstance(response, dict) else {}
        route = label(attempt.get('request_route'))
        parsed = urlsplit(route)
        if parsed.scheme not in {'https', 'http'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            route = 'unknown'
        identity = {'phase': attempt['phase'], 'request_model': label(request.get('model')),
                    'response_model': label(response.get('model')), 'request_route': route,
                    'system_fingerprint': (response.get('system_fingerprint')
                        if isinstance(response.get('system_fingerprint'), str) and len(response['system_fingerprint']) <= 300 else None),
                    'underlying_model_version': 'unknown'}
        values[content_digest(identity)] = identity
    return [values[key] for key in sorted(values)]


def suite_receipt(report):
    return content_digest(report['receipt_details'])


def build_suite_report(contract, snapshot, *, cases, attempts, members, errors, runs, calibration):
    """只从已复验的完整成员证据计算结论，不执行文件或数据库副作用。"""
    manifest = snapshot['manifest']
    current_id = contract_identity(contract)
    member_hash = content_digest(members)
    complete = len(cases) == len(manifest['fixtures']) and all(run['state'] == 'complete' for run in runs)
    aggregate = {'id': snapshot['suite_id'], 'contract_id': manifest['contract_id'],
        'contract': runs[0]['contract'] if runs else {}, 'stage': 'organization',
        'dataset_version': manifest['dataset_version'], 'dataset_sha256': snapshot['manifest_sha256'],
        'data_kind': 'fixed_synthetic', 'state': 'complete' if complete else 'incomplete',
        'case_count': len(manifest['fixtures']), 'max_http_attempts': manifest['max_http_attempts'],
        'http_attempts_used': sum(run['http_attempts_used'] for run in runs),
        'transport_kind': 'sdk' if runs and all(run['transport_kind'] == 'sdk' for run in runs) else 'incomplete',
        'input_review_frozen': bool(runs and all(run['input_review_frozen'] for run in runs)),
        'input_review_sha256': content_digest([run['input_review_sha256'] for run in runs]),
        'calibration': calibration}
    report = build_quality_report(aggregate, cases, attempts, current_id)
    reasons = [reason for reason in report['organization']['reasons'] if reason != 'coverage_insufficient']
    baseline = [fixture for fixture in manifest['fixtures'] if fixture['feedback_mode'] == 'baseline']
    baseline_ids = {fixture['case_id'] for fixture in baseline}
    counts = Counter(case['annotations']['dimension'] for case in cases
                     if str(case['id']) in baseline_ids and human_approved(case['annotations']))
    if (len(baseline) != 120 or len({fixture['scenario_key'] for fixture in baseline}) != 120
            or any(counts[name] < 15 for name in SEMANTIC_DIMENSIONS)):
        reasons.append('coverage_insufficient')
    feedback = {(fixture['scope_kind'], fixture['feedback_layer']) for fixture in manifest['fixtures']
                if fixture['feedback_mode'] == 'summary_error'}
    if (sum(fixture['feedback_mode'] == 'summary_error' for fixture in manifest['fixtures']) != 4
            or feedback != {(scope, layer) for scope in ('owner', 'contact') for layer in ('l2', 'l3')}):
        reasons.append('feedback_coverage_insufficient')
    facts = [fixture for fixture in manifest['fixtures'] if fixture['feedback_mode'] == 'fact_corrected']
    if len(facts) != 2 or {fixture['scope_kind'] for fixture in facts} != {'owner', 'contact'}:
        reasons.append('fact_correction_coverage_insufficient')
    if errors:
        reasons.extend(error['reason'] for error in errors)
    ledger = snapshot['reservations']
    physical_keys = Counter((row['source_ref'], row['owner_id'], row['run_id'], row['case_id'], row['phase']) for row in ledger)
    observed = Counter()
    for fixture in manifest['fixtures']:
        for attempt in attempts:
            if str(attempt['case_id']) == fixture['case_id']:
                observed[(fixture['source_ref']['key'], fixture['owner_id'], fixture['run_id'], fixture['case_id'], attempt['phase'])] += 1
    if (physical_keys != observed or any(row['outcome'] != 'succeeded' for row in ledger)
            or len(ledger) != aggregate['http_attempts_used']):
        reasons.append('suite_physical_receipts_incomplete')
    identities = model_identities(attempts)
    if any(identity['request_route'] == 'unknown' for identity in identities):
        reasons.append('actual_request_route_missing')
    if any(identity['request_model'] == 'unknown' or identity['response_model'] == 'unknown' for identity in identities):
        reasons.append('actual_model_identity_unknown')
    reasons = list(dict.fromkeys(reasons))
    status = ('unknown' if errors else 'failed' if report['organization']['status'] == 'failed'
              else 'unknown' if reasons else 'verified')
    report.update({'suite_id': snapshot['suite_id'], 'manifest_sha256': snapshot['manifest_sha256'],
                   'member_evidence_sha256': member_hash, 'members': members, 'member_errors': errors,
                   'baseline_case_count': len(baseline), 'dimensions': dict(counts),
                   'feedback_case_count': sum(fixture['feedback_mode'] == 'summary_error' for fixture in manifest['fixtures']),
                   'fact_correction_case_count': len(facts),
                   'physical_attempts_used': len(ledger), 'model_identities': identities})
    report['organization'] = {'status': status, 'reasons': reasons, 'contract_id': current_id,
                              'report_id': snapshot['suite_id']}
    report['receipt_details'] = {'suite_id': snapshot['suite_id'], 'manifest_sha256': snapshot['manifest_sha256'],
        'member_evidence_sha256': member_hash, 'report_sha256': content_digest(report),
        'budget_ledger_sha256': content_digest(ledger), 'calibration_sha256': content_digest(calibration),
        'member_count': len(members), 'physical_attempts_used': len(ledger), 'status': status}
    return report

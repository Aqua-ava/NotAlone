"""独立回复读取合同与证据判定；不授予整理资格。"""
from dataclasses import asdict
import json
from pathlib import Path
from collections import Counter

from notalone.memory.organization_quality import ReplyQualityContract, content_digest, _source_identity


def reply_model_configuration(model):
    """只取实际请求参数和接收路由，不取凭据或客户端内部状态。"""
    from notalone.reply.adapters.deepseek_provider import is_official_deepseek_flash
    from notalone.reply.adapters.deepseek_input_budget import DEEPSEEK_REVIEW_BASE_URL
    route = str(model.root_async_client.base_url).rstrip('/') + '/chat/completions'
    review_route = (DEEPSEEK_REVIEW_BASE_URL.rstrip('/') + '/chat/completions'
                    if is_official_deepseek_flash(model) else route)
    return {'request_model': model.model_name, 'request_route': route, 'review_route': review_route,
            'parameters': model._get_request_payload([]), 'sdk_retries': model.max_retries}


def build_reply_contract(model, profile, contact_budget, owner_budget):
    root = Path(__file__).resolve().parents[1]
    rules = {name: (root / name).read_text() for name in (
        'reply/context.py', 'reply/layered_context.py', 'reply/scenario_tools.py',
        'reply/adapters/langchain_runtime.py', 'reply/adapters/constraint_review.py',
        'reply/adapters/constraint_review_contract.py', 'reply/adapters/input_budget_middleware.py')}
    from notalone.reply.adapters.langchain_runtime import REPLY_RUNTIME_SCHEMA
    from langchain_core.utils.function_calling import convert_to_openai_tool
    config = reply_model_configuration(model)
    if (any(value != 0 for value in (model.max_retries, model.root_client.max_retries,
                                     model.root_async_client.max_retries)) or profile is None):
        raise ValueError('回复资格合同需要实际无隐藏重试模型及已核实预算。')
    budgets = {'contact': asdict(contact_budget) if contact_budget else None,
               'owner': asdict(owner_budget) if owner_budget else None, 'input': asdict(profile)}
    return ReplyQualityContract(model_version=content_digest(config), rules_version=content_digest(rules),
        schema_version=content_digest(convert_to_openai_tool(REPLY_RUNTIME_SCHEMA)),
        budget_version=content_digest(budgets), evaluation_version=_source_identity([
            'reply/quality.py', 'application/reply_qualification.py',
            'memory/organization_quality.py', 'reply/prepared_context_codec.py', 'persistence/reply_store.py',
            'experiments/reply_comparison.py', 'reply/adapters/reply_comparison_capture.py']))



def _generation_input(request):
    for message in reversed(request.get('messages', [])):
        if message.get('role') != 'user' or not isinstance(message.get('content'), str):
            continue
        try:
            value = json.loads(message['content'])
        except ValueError:
            continue
        if isinstance(value, dict) and 'input_mode' in value:
            inputs = {key: value.get(key) for key in ('input_mode', 'draft_text', 'current_text',
                'confirmed_direction', 'direction_source', 'confirmed_purpose', 'purpose_source',
                'user_instruction', 'include_relationship_context', 'understanding_correction', 'clarification_answer')}
            inputs['l1'] = [item for item in value.get('evidence', [])
                if item.get('kind') not in {'user_draft', 'user_current_chat', 'user_purpose'}]
            return inputs
    return None


def comparison_report(bundle, contract):
    """重新核对原始记录；上传的status/verified字段没有资格效力。"""
    manifest = bundle['manifest']
    reasons, failures = [], []
    if (bundle.get('schema_version') != 'reply-comparison-v1'
            or content_digest(manifest) != bundle.get('manifest_sha256')):
        raise ValueError('回复比较清单摘要不一致。')
    if manifest.get('contract_id') != contract.identity or manifest.get('reply_contract') != contract.to_payload():
        reasons.append('reply_contract_changed')
    if manifest.get('data_kind') != 'synthetic':
        raise ValueError('此来源仅接受固定合成评测。')
    cases = manifest.get('cases', [])
    identifiers = [case['case_id'] for case in cases]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError('回复案例身份重复。')
    expected = {(identifier, arm) for identifier in identifiers for arm in ('baseline', 'layered')}
    arms, calls, reviews = bundle.get('arms', []), bundle.get('calls', []), bundle.get('reviews', [])
    indexed = {(arm['case_id'], arm['arm']): arm for arm in arms}
    if len(indexed) != len(arms) or set(indexed) != expected or not expected:
        reasons.append('reply_comparison_incomplete')
    if any(arm.get('status') != 'succeeded' for arm in arms):
        reasons.append('reply_comparison_incomplete')
    for case in cases:
        pair = [indexed.get((case['case_id'], arm), {}) for arm in ('baseline', 'layered')]
        if any(arm.get('input_sha256') != case.get('input_sha256') for arm in pair):
            failures.append('reply_paired_input_changed')
        if (case.get('organization_review') or {}).get('decision') != 'approved':
            reasons.append('organization_candidate_not_supported')
    receipt = bundle.get('budget_receipt', {})
    limit = manifest.get('request_limit')
    if (type(limit) is not int or limit < 1 or receipt.get('closed') is not True
            or receipt.get('request_limit') != limit or receipt.get('reserved_requests') != len(calls)
            or receipt.get('config_sha256') != bundle['manifest_sha256']):
        reasons.append('reply_physical_ledger_incomplete')
    if type(limit) is int and len(calls) > limit:
        failures.append('reply_physical_budget_exceeded')
    per_arm = manifest.get('per_arm_limit')
    if type(per_arm) is not int or not 1 <= per_arm <= 6:
        raise ValueError('回复比较须有明确每组物理上限。')
    if any(count > per_arm for count in Counter((c['case_id'], c['arm']) for c in calls).values()):
        failures.append('reply_physical_budget_exceeded')
    if [call.get('sequence') for call in calls] != list(range(1, len(calls) + 1)):
        failures.append('reply_physical_sequence_changed')
    identities = []
    config = manifest.get('model_configuration', {})
    if content_digest(config) != contract.model_version:
        reasons.append('reply_model_configuration_changed')
    for call in calls:
        request, response = call.get('request') or {}, call.get('response') or {}
        identity = {'request_model': request.get('model'), 'response_model': response.get('model'),
                    'system_fingerprint': response.get('system_fingerprint'), 'request_route': call.get('request_route')}
        if ((call.get('case_id'), call.get('arm')) not in expected or call.get('outcome') != 'succeeded'
                or not identity['response_model'] or not isinstance(request.get('messages'), list)):
            reasons.append('reply_actual_model_evidence_incomplete')
        if (identity['request_model'] != config.get('request_model')
                or identity['request_route'] not in {config.get('request_route'), config.get('review_route')}):
            failures.append('reply_candidate_model_changed')
        identities.append(identity)
    for case in cases:
        actual_inputs, actual_budgets = [], []
        for arm in ('baseline', 'layered'):
            record = indexed.get((case['case_id'], arm), {})
            evidence = record.get('evidence') or {}
            arm_calls = [c for c in calls if (c.get('case_id'), c.get('arm')) == (case['case_id'], arm)]
            package = evidence.get('input_package')
            if package is None or content_digest(package) != case.get('input_sha256'):
                reasons.append('reply_input_capture_incomplete')
            if record.get('status') == 'succeeded' and not arm_calls:
                reasons.append('reply_actual_model_evidence_incomplete')
            first = arm_calls[0].get('request', {}) if arm_calls else {}
            if evidence.get('first_model_request') != first:
                reasons.append('reply_input_capture_incomplete')
            actual_inputs.append(_generation_input(first))
            actual_budgets.append(evidence.get('l1_budget'))
        if any(value is None for value in actual_inputs + actual_budgets):
            reasons.append('reply_input_capture_incomplete')
        elif actual_inputs[0] != actual_inputs[1] or actual_budgets[0] != actual_budgets[1]:
            failures.append('reply_paired_input_changed')
    observable = {(i['response_model'], i['system_fingerprint']) for i in identities}
    if len(observable) != 1:
        reasons.append('reply_actual_model_evidence_incomplete')
    review_index = {(r['case_id'], r['arm']): r for r in reviews}
    if len(review_index) != len(reviews) or set(review_index) != expected:
        reasons.append('reply_output_review_missing')
    if any(r.get('reviewer_kind') != 'human' for r in reviews) or not reviews:
        reasons.append('reply_human_review_missing')
    if any(r.get('decision') != 'approved' for r in reviews):
        failures.append('reply_semantic_failure')
    dimensions = {'background_use', 'irrelevant_interference', 'instruction_pollution',
                  'facts_commitments', 'l1_preserved', 'naturalness'}
    if any(not dimensions <= set(r.get('dimensions') or {})
           or any(not isinstance((r.get('dimensions') or {}).get(name), dict)
                  or (r.get('dimensions') or {}).get(name, {}).get('status') not in {'pass', 'fail', 'unknown'}
                  or not (r.get('dimensions') or {}).get(name, {}).get('basis') for name in dimensions)
           for r in reviews):
        reasons.append('reply_output_review_missing')
    if (manifest.get('coverage_kind') != 'formal' or len(cases) < 126
            or any((c.get('organization_review') or {}).get('reviewer_kind') != 'human' for c in cases)):
        reasons.append('reply_formal_coverage_missing')
    if not (manifest.get('calibration', {}).get('reviewer_kind') == 'human'
            and manifest.get('calibration', {}).get('decision') == 'approved'
            and manifest.get('calibration', {}).get('budget_version') == contract.budget_version):
        reasons.append('reply_budget_calibration_missing')
    if any(value.get('status') != 'pass' for r in reviews
           for value in (r.get('dimensions') or {}).values() if isinstance(value, dict)):
        failures.append('reply_semantic_failure')
    # 冒烟只有实际覆盖结论，语义失败不会伪造为正式资格已验证。
    status = 'unknown' if manifest.get('coverage_kind') != 'formal' else 'failed' if failures else 'unknown' if reasons else 'verified'
    return {'stage': {'status': status, 'reasons': sorted(set(reasons + failures)),
                      'contract_id': contract.identity, 'report_id': content_digest(bundle)},
            'receipt': content_digest(bundle), 'model_identities': identities,
            'counts': {'cases': len(cases), 'arms': len(arms), 'physical_attempts': len(calls),
                       'not_succeeded': sum(a.get('status') != 'succeeded' for a in arms)}}

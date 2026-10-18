"""通过正式 HTTP 构造合成整理输入；不调用模型、不签发质量资格。"""

from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import date, datetime
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID, uuid4


SCHEMA = 'organization-public-construction-v2'


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in rows),
                    encoding='utf-8')


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding='utf-8'))


def planned_text(memory: dict, policy: str) -> str:
    text = memory['body']
    if not isinstance(text, str) or not text.strip():
        raise ValueError('草稿正文不能为空。')
    if policy == 'unchanged':
        return text
    source_time = memory.get('temporal_status', {}).get('source_time')
    if source_time is None:
        return '合成资料记述日期未知。' + text
    if isinstance(source_time, str) and len(source_time) == 10:
        date.fromisoformat(source_time)
        return f'合成资料记述日期：{source_time}（时刻与时区未知；仅为合成正文日期，并非后端来源时间）。' + text
    if not isinstance(source_time, str) or datetime.fromisoformat(source_time).tzinfo is None:
        raise ValueError('合成日期须为 ISO 日期、含时区时刻或 null；不得补造时区。')
    return f'合成资料记述日期：{source_time}（仅为合成正文日期，并非后端来源时间）。' + text


def create_plan(args: argparse.Namespace) -> dict:
    dataset_hash = file_digest(args.dataset)
    worksheet = read_json(args.worksheet)
    scoring = read_json(args.scoring_contract)
    source_overrides = {}
    if args.source_time_overrides:
        overrides = read_json(args.source_time_overrides)
        if set(overrides) != {'schema_version', 'entries'} or overrides['schema_version'] != 'synthetic-source-time-overrides-v1':
            raise ValueError('合成消息时刻重构表版本无效。')
        for item in overrides['entries']:
            if (set(item) != {'draft_memory_id', 'original_date_only', 'source_message_at', 'assumption'}
                    or item['assumption'] != 'agent_chosen_synthetic_message_time'
                    or item['draft_memory_id'] in source_overrides):
                raise ValueError('合成消息时刻重构表字段、假设声明或唯一性无效。')
            date.fromisoformat(item['original_date_only'])
            validate_date(item['source_message_at'])
            if item['source_message_at'] is None:
                raise ValueError('重构的合成消息时刻不能为 null。')
            source_overrides[item['draft_memory_id']] = item
    for source in (worksheet, scoring):
        if source.get('dataset_draft_sha256', dataset_hash) != dataset_hash:
            raise ValueError('准备文件的 dataset 摘要不一致。')
    rows = [json.loads(line) for line in args.dataset.read_text(encoding='utf-8').splitlines()
            if line.strip()]
    if not rows or len({row['case_id'] for row in rows}) != len(rows):
        raise ValueError('场景必须非空且 case_id 唯一。')
    if {row['case_id'] for row in worksheet['cases']} != {row['case_id'] for row in rows}:
        raise ValueError('worksheet 的场景集合与 dataset 不一致。')
    cases, used_overrides, memory_ids = [], set(), set()
    for row in rows:
        if row['scope_kind'] not in {'owner', 'contact'} or not row['memories']:
            raise ValueError('范围须为 owner/contact，且每例须有记忆。')
        entries = []
        for memory in row['memories']:
            if memory['id'] in memory_ids:
                raise ValueError('草稿记忆 ID 必须在整个构造计划中唯一。')
            memory_ids.add(memory['id'])
            provenance = memory['provenance']
            if provenance not in {'source_supported', 'manual_entry'}:
                raise ValueError('草稿来源标签未知。')
            source_entry = provenance == 'source_supported' and not args.manual_entry_rebinding
            gaps = ['synthetic_source_constructed_via_public_import' if source_entry
                    else 'draft_time_is_not_backend_source_time', 'human_support_review_required']
            source_time = memory.get('temporal_status', {}).get('source_time')
            if source_entry and memory['id'] in source_overrides:
                override = source_overrides[memory['id']]
                used_overrides.add(memory['id'])
                if source_time != override['original_date_only']:
                    raise ValueError('消息时刻重构表的原日历日与草稿不一致。')
                source_time = override['source_message_at']
                validate_date(source_time)
                if source_time is None:
                    raise ValueError('公开来源提取尚不接受未知消息时刻；不得把 null override 当作已就绪。')
                gaps.append('explicit_synthetic_source_time_reconstruction_requires_review')
            ready = (isinstance(source_time, str) and len(source_time) > 10
                     and datetime.fromisoformat(source_time).tzinfo is not None)
            if source_entry and row['scope_kind'] != 'contact':
                raise ValueError('来源支持构造仅适用于明确的联系人来源；本人不跨联系人读取。')
            if source_entry and not ready:
                gaps.append('public_import_requires_aware_message_time_unresolved')
            if provenance == 'source_supported' and not source_entry:
                gaps.append('source_supported_rebound_to_manual_entry')
            entries.append({'draft_memory': memory,
                            'actual_entry_kind': 'source_supported' if source_entry else 'manual_entry',
                            'text': memory['body'] if source_entry else planned_text(memory, args.source_date_policy),
                            'source_message_time': source_time if source_entry and ready else None,
                            'source_time_override': source_overrides.get(memory['id']) if source_entry else None,
                            'construction_ready': ready if source_entry else True,
                            'category': 'common_fact', 'conversion_gaps': gaps})
        if len({entry['draft_memory']['id'] for entry in entries}) != len(entries):
            raise ValueError('同场景的草稿记忆 ID 必须唯一。')
        cases.append({'draft_case': row, 'entries': entries})
    if set(source_overrides) != used_overrides:
        raise ValueError('重构表包含未绑定的草稿来源 ID；不得静默忽略。')
    result = {'schema_version': SCHEMA, 'evidence_kind': 'public_construction_plan',
              'source_dataset_sha256': dataset_hash,
              'source_worksheet_sha256': file_digest(args.worksheet),
              'source_scoring_contract_sha256': file_digest(args.scoring_contract),
              'source_time_overrides_sha256': file_digest(args.source_time_overrides) if args.source_time_overrides else None,
              'draft_scoring_contract': scoring,
              'source_date_policy': args.source_date_policy,
              'manual_entry_rebinding': args.manual_entry_rebinding,
              'construction_ready': all(entry['construction_ready'] for case in cases for entry in case['entries']),
              'review_status': 'unknown', 'quality_verified': False, 'cases': cases}
    args.output_dir.mkdir(parents=True, exist_ok=False)
    write_json(args.output_dir / 'construction-plan.json', result)
    return {'plan': str(args.output_dir / 'construction-plan.json'), 'cases': len(cases),
            'plan_sha256': file_digest(args.output_dir / 'construction-plan.json'),
            'construction_ready': result['construction_ready'],
            'review_status': 'unknown', 'quality_verified': False}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('后端重定向已拒绝；须显式指定最终 baseURL。')


class PublicBackend:
    """仅访问调用者指定的后端；凭据不落盘、不随重定向转发。"""

    def __init__(self, base_url: str, token_env: str, audit: Path, timeout: float):
        parsed = urlsplit(base_url)
        if (parsed.scheme not in {'http', 'https'} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError('baseURL 必须是无凭据、查询或片段的明确 HTTP(S) 地址。')
        token = os.environ.get(token_env)
        if not token or '\n' in token or '\r' in token:
            raise ValueError(f'显式 token 环境变量 {token_env} 未提供合法值。')
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.audit = audit
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), NoRedirect())
        self.sequence = 0

    def record(self, entry: dict) -> None:
        with self.audit.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(entry, ensure_ascii=False) + '\n')

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        self.sequence += 1
        self.record({'sequence': self.sequence, 'phase': 'request', 'method': method,
                     'path': path, 'body': body})
        request = Request(self.base_url + path, data=None if body is None else json.dumps(body).encode(), method=method,
                          headers={'Authorization': f'Bearer {self.token}',
                                   'Content-Type': 'application/json'})
        try:
            try:
                response = self.opener.open(request, timeout=self.timeout)
            except HTTPError as error:
                response = error
            with response:
                status = response.status
                payload = json.loads(response.read())
        except (URLError, OSError, ValueError):
            self.record({'sequence': self.sequence, 'phase': 'transport_failed'})
            raise ValueError('公开 HTTP 未返回可用 JSON；保留审计且不自动重试。') from None
        self.record({'sequence': self.sequence, 'phase': 'response', 'status': status,
                     'body': payload})
        if status not in {200, 201} or not isinstance(payload, dict):
            raise ValueError(f'公开 HTTP 返回 {status}；保留审计且不自动重试。')
        return payload

    def post(self, path: str, body: dict) -> dict:
        return self.request('POST', path, body)

    def get(self, path: str) -> dict:
        return self.request('GET', path)

    def event_stream(self):
        self.sequence += 1
        self.record({'sequence': self.sequence, 'phase': 'request', 'method': 'GET', 'path': '/api/events'})
        request = Request(self.base_url + '/api/events', headers={
            'Authorization': f'Bearer {self.token}', 'Connection': 'close'})
        response = self.opener.open(request, timeout=self.timeout)
        self.record({'sequence': self.sequence, 'phase': 'response', 'status': response.status,
                     'content_type': response.headers.get('Content-Type')})
        if response.status != 200 or not response.headers.get('Content-Type', '').startswith('text/event-stream'):
            response.close()
            raise ValueError('来源构造需要正式任务事件流；不得轮询或伪造完成。')
        return response


def validate_plan(plan: dict) -> None:
    if (plan['schema_version'] != SCHEMA or plan['review_status'] != 'unknown'
            or plan['quality_verified'] is not False or not plan['cases']):
        raise ValueError('只接受未授予资格的当前构造计划。')
    if plan['source_date_policy'] not in {'unchanged', 'append-draft-source-date'}:
        raise ValueError('计划须显式保留日期处理选择。')
    case_ids = set()
    for case in plan['cases']:
        draft = case['draft_case']
        if draft['case_id'] in case_ids or draft['scope_kind'] not in {'contact', 'owner'}:
            raise ValueError('场景 ID 重复或 scope 无效。')
        case_ids.add(draft['case_id'])
        original = {memory['id']: memory for memory in draft['memories']}
        if not original or len(case['entries']) != len(original):
            raise ValueError('计划必须逐条绑定原草稿记忆。')
        seen = set()
        for entry in case['entries']:
            memory = entry['draft_memory']
            if memory != original[memory['id']] or memory['id'] in seen:
                raise ValueError('原草稿不可更改；编辑构造正文请修改 text。')
            seen.add(memory['id'])
            if (entry['actual_entry_kind'] not in {'manual_entry', 'source_supported'}
                    or entry['category'] not in {'common_fact', 'preference', 'taboo'}
                    or not isinstance(entry['text'], str) or not entry['text'].strip()):
                raise ValueError('手录字段无效；不得把草稿来源或时间伪装为后端字段。')
            if memory['provenance'] == 'source_supported':
                if entry['actual_entry_kind'] == 'manual_entry' and not plan['manual_entry_rebinding']:
                    raise ValueError('source_supported 转换缺少 --manual-entry-rebinding。')
                if (entry['actual_entry_kind'] == 'manual_entry'
                        and 'source_supported_rebound_to_manual_entry' not in entry['conversion_gaps']):
                    raise ValueError('不得移除来源转换缺口。')
            if entry['actual_entry_kind'] == 'source_supported':
                if draft['scope_kind'] != 'contact' or memory['provenance'] != 'source_supported':
                    raise ValueError('来源支持入口必须保留原联系人来源标签。')
                if not entry['construction_ready'] or entry['source_message_time'] is None:
                    raise ValueError('公开来源导入需要明确含时区的合成消息时刻；未解决日期项不能执行。')
                validate_date(entry['source_message_time'])


def validate_date(value: object) -> None:
    if value is not None and (not isinstance(value, str) or datetime.fromisoformat(value).tzinfo is None):
        raise ValueError('后端时间投影包含非法日期。')


def validate_event(event: object, *, owner: bool) -> None:
    if event is None:
        return
    fields = {'stage', 'occurrence_start', 'occurrence_end', 'stage_verified', 'occurrence_verified'}
    if not owner:
        fields |= {'version', 'stage_evidence', 'occurrence_evidence'}
    if (not isinstance(event, dict) or set(event) != fields
            or event['stage'] not in {'planned', 'agreed', 'rescheduled', 'cancelled', 'occurred', 'unknown'}
            or type(event['stage_verified']) is not bool or type(event['occurrence_verified']) is not bool):
        raise ValueError('后端事件投影不符合当前 scope 事件白名单。')
    for field in ('occurrence_start', 'occurrence_end'):
        validate_date(event[field])
    if not owner:
        if type(event['version']) is not int or event['version'] != 1:
            raise ValueError('联系人事件版本无效。')
        for field in ('stage_evidence', 'occurrence_evidence'):
            if not isinstance(event[field], list) or len(event[field]) > 8:
                raise ValueError('联系人事件依据超出公开合同。')
            for evidence in event[field]:
                if (not isinstance(evidence, dict) or set(evidence) != {'message_id', 'char_start', 'char_end'}
                        or type(evidence['char_start']) is not int or type(evidence['char_end']) is not int
                        or not 0 <= evidence['char_start'] < evidence['char_end'] <= 100000):
                    raise ValueError('联系人事件依据不符合公开合同。')
                UUID(evidence['message_id'])


def validate_timing(timing: object, *, owner: bool) -> None:
    fields = {'recorded_at', 'source_started_at', 'source_ended_at', 'source_time_complete', 'current_status'}
    fields |= {'valid_at', 'invalid_at', 'event'} if owner else {'current_status_reason'}
    if (not isinstance(timing, dict) or set(timing) != fields
            or type(timing['source_time_complete']) is not bool
            or timing['current_status'] not in {'current_verified', 'current_unverified', 'historical', 'stable'}):
        raise ValueError('后端时间投影不符合当前 scope 的 MemoryTiming 白名单。')
    for field in ('recorded_at', 'source_started_at', 'source_ended_at'):
        validate_date(timing[field])
    if owner:
        validate_date(timing['valid_at'])
        validate_date(timing['invalid_at'])
        validate_event(timing['event'], owner=True)
    elif not isinstance(timing['current_status_reason'], str) or not timing['current_status_reason'].strip():
        raise ValueError('联系人时间核实依据无效。')


def validate_prepared(prepared: dict, binding: dict) -> None:
    expected_contact = binding['contact_id']
    if (prepared['scope_kind'] != binding['scope_kind']
            or prepared['contact_id'] != expected_contact
            or prepared['review_status'] != 'unknown' or prepared['quality_verified'] is not False
            or not prepared['case_id'] or not prepared['contract_id']):
        raise ValueError('后端质量输入范围或待审状态不符合本次绑定。')
    model_input = prepared['model_input']
    if (set(model_input) != {'memories', 'scenarios', 'corrections'}
            or model_input['scenarios'] != [] or model_input['corrections'] != []):
        raise ValueError('后端模型投影包含本次构造之外的字段或场景。')
    expected = {item['actual_memory_id']: item for item in binding['memories']}
    actual = model_input['memories']
    if (len(actual) != len(expected)
            or {memory['memory_id'] for memory in actual} != set(expected)):
        raise ValueError('后端模型输入的实际记忆集合不符合选择。')
    for memory in actual:
        entry = expected[memory['memory_id']]
        owner = binding['scope_kind'] == 'owner'
        fields = {'memory_id', 'revision', 'text', 'timing'}
        if not owner:
            fields |= {'provenance_kind', 'event', 'category', 'valid_at', 'invalid_at'}
        if (set(memory) != fields
                or memory['revision'] != entry['actual_revision'] or memory['text'] != entry['text']):
            raise ValueError('后端模型输入字段、版本或正文不符合白名单。')
        validate_timing(memory['timing'], owner=owner)
        if not owner:
            if (memory['provenance_kind'] != entry['actual_entry_kind']
                    or memory['category'] not in {'common_fact', 'preference', 'taboo', 'recent_state', 'relationship_note'}):
                raise ValueError('联系人模型输入的实际来源或分类不符合选择。')
            validate_date(memory['valid_at'])
            validate_date(memory['invalid_at'])
            validate_event(memory['event'], owner=False)
        entry['actual_model_timing'] = memory['timing']
    construction = prepared['construction']
    if (len(construction) != len(expected)
            or {item['memory_id'] for item in construction} != set(expected)):
        raise ValueError('后端构造证明集合不符合本次选择。')
    for item in construction:
        entry = expected[item['memory_id']]
        if item['revision'] != entry['actual_revision'] or item['provenance_kind'] != entry['actual_entry_kind']:
            raise ValueError('后端实际来源或版本不符合本次公开构造路径。')
        common_fields = {'recorded_at', 'source_started_at', 'source_ended_at',
                         'source_time_complete', 'current_status'}
        validate_timing(item['timing'], owner=False)
        if binding['scope_kind'] == 'contact':
            common_fields |= {'current_status_reason'}
        if (not isinstance(item['timing'], dict)
                or {key: item['timing'][key] for key in common_fields}
                != {key: entry['actual_model_timing'][key] for key in common_fields}):
            raise ValueError('后端构造时间与模型输入时间不一致。')
        entry['actual_eligibility'] = item['provenance_kind']
        entry['actual_public_timing'] = item['timing']
    if digest(model_input) != prepared['input_sha256']:
        raise ValueError('后端模型输入摘要不符合实际返回内容。')


def rebound_review(case: dict, binding: dict) -> dict:
    row = deepcopy(case['draft_case'])
    by_draft = {entry['draft_memory']['id']: entry for entry in binding['memories']}
    row['memories'] = [{'id': item['actual_memory_id'], 'version': item['actual_revision'],
                        'body': item['text'], 'provenance': item['actual_eligibility'],
                        'timing': item['actual_public_timing'], 'draft_original': item['draft_memory'],
                        'model_timing': item['actual_model_timing'],
                        'conversion_gaps': item['conversion_gaps']}
                       for item in binding['memories']]
    for claim in row.get('supported_claims', []):
        claim['draft_source_memory_ids'] = claim['source_memory_ids']
        claim['source_memory_ids'] = [by_draft[identifier]['actual_memory_id']
                                      for identifier in claim['source_memory_ids']]
        claim['review_status'] = 'unknown'
    row.update({'annotation_status': 'unknown', 'review_status': 'unknown', 'quality_verified': False,
                'actual_case_id': binding['actual_case_id'],
                'actual_model_input_sha256': binding['actual_model_input_sha256'],
                'support_mapping_is_draft': True})
    return row


def bind_actual_memory(entry: dict, memory: dict) -> None:
    actual_id = str(UUID(memory['memory_id']))
    if type(memory['revision']) is not int or memory['revision'] < 1:
        raise ValueError('公开构造未返回合法实际 revision。')
    entry.update({'actual_memory_id': actual_id, 'actual_revision': memory['revision'],
                  'actual_memory_response': memory, 'actual_eligibility': None, 'actual_public_timing': None,
                  'draft_to_actual_time_mapping': ('actual_imported_source_time' if entry['actual_entry_kind']
                                                  == 'source_supported' else 'draft_metadata_not_backend_time')})


def apply_plan(args: argparse.Namespace) -> dict:
    plan = read_json(args.plan)
    validate_plan(plan)
    if args.timeout <= 0 or args.timeout > 120:
        raise ValueError('单次 HTTP 超时须大于 0 且不超过 120 秒。')
    contact_id = str(UUID(args.contact_id)) if args.contact_id else None
    if args.contact_per_case and (contact_id or not args.create_contact_name):
        raise ValueError('--contact-per-case 须提供 --create-contact-name 前缀，不能同时选择已有 contact。')
    source_entries = [entry for case in plan['cases'] for entry in case['entries']
                      if entry['actual_entry_kind'] == 'source_supported']
    if source_entries:
        if not args.controlled_source_backend or not args.source_files_shared_with_backend:
            raise ValueError('来源构造须显式 --controlled-source-backend --source-files-shared-with-backend。')
        if (not args.source_owner_external_id or not args.source_contact_external_id
                or any(not value.startswith('wxid_synthetic_') for value in (
                    args.source_owner_external_id, args.source_contact_external_id))):
            raise ValueError('来源构造须显式指定两个 wxid_synthetic_ 前缀的合成渠道标识。')
    if (any(case['draft_case']['scope_kind'] == 'contact' for case in plan['cases'])
            and not contact_id and not args.create_contact_name):
        raise ValueError('联系人场景须显式 --contact-id 或 --create-contact-name。')
    backend = PublicBackend(args.backend_base_url, args.token_env,
                            args.output_dir / 'http-exchanges.jsonl', args.timeout)
    args.output_dir.mkdir(parents=True, exist_ok=False)
    state = {'schema_version': SCHEMA, 'evidence_kind': 'public_http_construction',
             'backend_base_url': backend.base_url, 'plan_sha256': file_digest(args.plan),
             'source_dataset_sha256': plan['source_dataset_sha256'],
             'source_time_overrides_sha256': plan['source_time_overrides_sha256'],
             'source_date_policy': plan['source_date_policy'],
             'manual_entry_rebinding': plan['manual_entry_rebinding'],
             'planned_cases': len(plan['cases']), 'constructed_cases': 0,
             'constructed_l1_cases': 0, 'quality_prepared_cases': 0,
             'defer_quality_input': args.defer_quality_input, 'contact_per_case': args.contact_per_case,
             'construction_status': 'running', 'review_status': 'unknown',
             'quality_verified': False, 'contact_id': contact_id, 'cases': []}
    state_path = args.output_dir / 'public-bindings.json'
    write_json(state_path, state)
    try:
        if not args.contact_per_case and any(case['draft_case']['scope_kind'] == 'contact' for case in plan['cases']):
            if args.create_contact_name:
                created = backend.post('/api/contacts', {'request_id': str(uuid4()),
                                                        'display_name': args.create_contact_name})
                contact_id = str(UUID(created['contact']['contact_id']))
                if created['contact']['display_name'] != args.create_contact_name:
                    raise ValueError('创建联系人返回的显示名与显式请求不一致。')
            state['contact_id'] = contact_id
            write_json(state_path, state)
            if not contact_id:
                raise ValueError('联系人场景须显式 --contact-id 或 --create-contact-name。')
            if backend.post(f'/api/contacts/{contact_id}/manual-confirmation', {}) != {'confirmed': True}:
                raise ValueError('联系人未完成手动输入确认。')
        for index, case in enumerate(plan['cases']):
            draft = case['draft_case']
            scoped_contact = contact_id if draft['scope_kind'] == 'contact' else None
            if draft['scope_kind'] == 'contact' and args.contact_per_case:
                name = f'{args.create_contact_name}-{index + 1}'
                created = backend.post('/api/contacts', {'request_id': str(uuid4()), 'display_name': name})
                scoped_contact = str(UUID(created['contact']['contact_id']))
                if created['contact']['display_name'] != name:
                    raise ValueError('逐case联系人显示名与显式请求不一致。')
                if backend.post(f'/api/contacts/{scoped_contact}/manual-confirmation', {}) != {'confirmed': True}:
                    raise ValueError('逐case联系人确认失败。')
            binding = {'draft_case_id': draft['case_id'], 'scope_kind': draft['scope_kind'],
                       'contact_id': scoped_contact, 'construction_status': 'running',
                       'review_status': 'unknown', 'quality_verified': False,
                       'memories': deepcopy(case['entries'])}
            state['cases'].append(binding)
            for entry in binding['memories']:
                entry['actual_contact_id'] = scoped_contact
        source_jobs = sorted((entry for binding in state['cases'] for entry in binding['memories']
                              if entry['actual_entry_kind'] == 'source_supported'),
                             key=lambda entry: (entry['actual_contact_id'],
                                                datetime.fromisoformat(entry['source_message_time'])))
        state['source_construction_order'] = [entry['draft_memory']['id'] for entry in source_jobs]
        write_json(state_path, state)
        for mapped in source_jobs:
            from notalone.experiments.organization_quality_source import construct_source_memory
            memory = construct_source_memory(backend, mapped, mapped['actual_contact_id'], args,
                                             lambda: write_json(state_path, state))
            bind_actual_memory(mapped, memory)
            write_json(state_path, state)
        model_inputs, reviews = [], []
        for case, binding in zip(plan['cases'], state['cases'], strict=True):
            scoped_contact = binding['contact_id']
            for mapped in binding['memories']:
                if mapped['actual_entry_kind'] == 'manual_entry':
                    path = '/api/memories/manual-owner' if scoped_contact is None else '/api/memories/manual-contact'
                    body = {'text': mapped['text'], 'category': mapped['category']}
                    if scoped_contact is not None:
                        body['contact_id'] = scoped_contact
                    mapped.update({'public_entrypoint': path, 'request_fields': body})
                    write_json(state_path, state)
                    memory = backend.post(path, body)['memory']
                    bind_actual_memory(mapped, memory)
                write_json(state_path, state)
            path = ('/api/memories/owner/layered-memory/quality-input' if scoped_contact is None
                    else f'/api/contacts/{scoped_contact}/layered-memory/quality-input')
            body = {'memory_versions': [{'memory_id': item['actual_memory_id'],
                                         'revision': item['actual_revision']} for item in binding['memories']]}
            state['constructed_l1_cases'] += 1
            if args.defer_quality_input:
                binding.update({'construction_status': 'l1_constructed_quality_deferred',
                                'pending_quality_input_request': {'path': path, 'body': body},
                                'quality_input_prepared': False})
                write_json(state_path, state)
                continue
            prepared = backend.post(path, body)['quality_input']
            validate_prepared(prepared, binding)
            binding.update({'construction_status': 'bound_pending_human',
                            'actual_case_id': prepared['case_id'], 'contract_id': prepared['contract_id'],
                            'actual_model_input_sha256': prepared['input_sha256'],
                            'model_input_line': len(model_inputs) + 1,
                            'quality_input_request': {'path': path, 'body': body},
                            'quality_input_response': prepared})
            model_inputs.append(prepared['model_input'])
            reviews.append(rebound_review(case, binding))
            state['constructed_cases'] += 1
            state['quality_prepared_cases'] += 1
            write_json(state_path, state)
        if args.defer_quality_input:
            state['construction_status'] = 'l1_constructed_quality_deferred'
            write_json(state_path, state)
            write_json(args.output_dir / 'artifact-hashes.json', {path.name: file_digest(path)
                       for path in sorted(args.output_dir.iterdir()) if path.is_file()})
            return {'output_dir': str(args.output_dir), 'constructed_l1_cases': state['constructed_l1_cases'],
                    'quality_prepared_cases': 0, 'review_status': 'unknown', 'quality_verified': False}
        write_jsonl(args.output_dir / 'model-inputs.jsonl', model_inputs)
        write_jsonl(args.output_dir / 'dataset-rebound.jsonl', reviews)
        rebound_hash = file_digest(args.output_dir / 'dataset-rebound.jsonl')
        scoring_review = deepcopy(plan['draft_scoring_contract'])
        by_case = {case['draft_case_id']: case for case in state['cases']}
        for candidate in scoring_review.get('uncertainty_candidates', []):
            candidate['draft_source_memory_ids'] = candidate['source_memory_ids']
            mapping = {entry['draft_memory']['id']: entry['actual_memory_id']
                       for entry in by_case[candidate['case_id']]['memories']}
            candidate['source_memory_ids'] = [mapping[identifier]
                                               for identifier in candidate['source_memory_ids']]
            candidate['review_status'] = 'unknown'
        write_json(args.output_dir / 'support-review.json', {
            'evidence_kind': 'draft_support_mapping_for_human_review', 'review_status': 'unknown',
            'quality_verified': False, 'dataset_rebound_sha256': rebound_hash,
            'source_scoring_contract_sha256': plan['source_scoring_contract_sha256'],
            'draft_scoring_contract': scoring_review,
            'cases': reviews})
        entries = [entry for case in state['cases'] for entry in case['memories']]
        required = sum(entry['draft_memory']['provenance'] == 'source_supported' for entry in entries)
        actual_source = sum(entry['actual_eligibility'] == 'source_supported' for entry in entries)
        downgraded = sum(entry['draft_memory']['provenance'] == 'source_supported'
                         and entry['actual_eligibility'] == 'manual_entry' for entry in entries)
        state.update({'construction_status': 'bound_pending_human', 'dataset_rebound_sha256': rebound_hash,
                      'provenance_coverage': {'original_source_supported': required,
                          'actual_source_supported': actual_source, 'source_supported_rebound_to_manual': downgraded,
                          'source_supported_coverage_complete': actual_source == required and downgraded == 0}})
        write_json(state_path, state)
        write_json(args.output_dir / 'artifact-hashes.json', {path.name: file_digest(path)
                   for path in sorted(args.output_dir.iterdir()) if path.is_file()})
    except Exception:
        state['construction_status'] = 'failed'
        write_json(state_path, state)
        raise
    return {'output_dir': str(args.output_dir), 'constructed_cases': state['constructed_cases'],
            'dataset_rebound_sha256': state['dataset_rebound_sha256'],
            'review_status': 'unknown', 'quality_verified': False}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest='command', required=True)
    plan = commands.add_parser('plan', help='离线生成可编辑的人审构造计划。')
    plan.add_argument('--dataset', type=Path, required=True)
    plan.add_argument('--worksheet', type=Path, required=True)
    plan.add_argument('--scoring-contract', type=Path, required=True)
    plan.add_argument('--output-dir', type=Path, required=True)
    plan.add_argument('--manual-entry-rebinding', action='store_true')
    plan.add_argument('--source-time-overrides', type=Path,
                      help='显式的新合成消息时刻重构表；须重新人审，不从日历日推断时区。')
    plan.add_argument('--source-date-policy', choices=['unchanged', 'append-draft-source-date'],
                      required=True, help='显式决定是否把草稿合成日期写入正文；不改后端时间。')
    apply = commands.add_parser('apply', help='向显式后端写入合成手录并绑定公开质量输入。')
    apply.add_argument('--plan', type=Path, required=True)
    apply.add_argument('--backend-base-url', required=True)
    apply.add_argument('--token-env', required=True, help='仅从此显式环境变量读取 token，不读取 .env。')
    contact = apply.add_mutually_exclusive_group()
    contact.add_argument('--contact-id')
    contact.add_argument('--create-contact-name')
    apply.add_argument('--output-dir', type=Path, required=True)
    apply.add_argument('--timeout', type=float, default=20)
    apply.add_argument('--controlled-source-backend', action='store_true')
    apply.add_argument('--source-files-shared-with-backend', action='store_true')
    apply.add_argument('--source-owner-external-id')
    apply.add_argument('--source-contact-external-id')
    apply.add_argument('--confirm-source-candidates', action='store_true')
    apply.add_argument('--contact-per-case', action='store_true')
    apply.add_argument('--defer-quality-input', action='store_true')
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = create_plan(args) if args.command == 'plan' else apply_plan(args)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'构造失败：{error}', file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

"""合成来源支持构造：公开导入、生产任务及显式候选确认。"""

from datetime import datetime
import hashlib
import json
import time
from uuid import uuid4


def wait_source_task(backend, stream, *, contact_id: str, task_id: str) -> dict:
    """一次有界事件等待；不反复轮询、不重启或重试任务。"""
    deadline = time.monotonic() + 60
    for _ in range(1000):
        if time.monotonic() >= deadline:
            raise ValueError('来源导入任务未在60秒内完成；保留审计且不自动重试。')
        raw = stream.readline()
        if not raw:
            raise ValueError('来源任务事件流提前结束。')
        if not raw.startswith(b'data: '):
            continue
        event = json.loads(raw[6:])
        payload = event.get('payload', {})
        if event.get('type') != 'task.progress' or payload.get('task_id') != task_id:
            continue
        backend.record({'phase': 'source_task_progress', 'task_id': task_id,
                        'step': payload.get('step'), 'status': payload.get('status')})
        if payload.get('status') == 'failed':
            raise ValueError('来源导入生产Worker失败；不得生成或确认替代候选。')
        if payload.get('step') == 'verify' and payload.get('status') == 'succeeded':
            state = backend.get(f'/api/tasks/status?contact_id={contact_id}&task_id={task_id}')
            if state['status'] != 'succeeded':
                raise ValueError('来源任务事件与持久状态不一致。')
            return state
    raise ValueError('来源导入任务事件超过有限上限。')


def construct_source_memory(backend, entry: dict, contact_id: str, args, save_state) -> dict:
    timestamp = datetime.fromisoformat(entry['source_message_time'])
    directory = args.output_dir / 'synthetic-sources'
    directory.mkdir(exist_ok=True)
    source_path = directory / f'{uuid4().hex}.jsonl'
    records = []
    locator = (f'{args.source_contact_external_id}_{contact_id.replace("-", "")}'
               if args.contact_per_case else args.source_contact_external_id)
    for index, from_me, text in ((0, False, entry['text']), (1, True, '好的，合成来源已收到。')):
        when = timestamp
        records.append({
            'id': {'local_id': uuid4().int % (2 ** 62), 'server_id_str': uuid4().hex,
                   'talker': locator},
            'create_time': int(when.timestamp()), 'is_from_me': from_me, 'kind': 'text',
            'sender': '合成用户' if from_me else '合成联系人',
            'sender_wxid': args.source_owner_external_id if from_me else locator,
            'text': text, 'time': when.strftime('%Y-%m-%d %H:%M:%S'), 'time_iso': when.isoformat(),
        })
    source_path.write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in records), encoding='utf-8')
    source = {'path': str(source_path.resolve()),
              'content_sha256': hashlib.sha256(source_path.read_bytes()).hexdigest(),
              'source_message_time': entry['source_message_time'],
              'source_time_override': entry.get('source_time_override'), 'record_count': len(records),
              'contact_external_id': locator,
              'controlled_adapter_required': True, 'confirmation_requested': args.confirm_source_candidates}
    entry.update({'public_entrypoint': '/api/imports/preview → /api/imports/commit → production Worker',
                  'source_import': source})
    save_state()
    request = {'path': source['path'], 'contact_id': contact_id}
    preview = backend.post('/api/imports/preview', request)
    if not preview.get('valid') or preview['content_sha256'] != source['content_sha256']:
        raise ValueError('来源预览或内容摘要不一致；停止构造。')
    source['preview_response'] = preview
    save_state()
    with backend.event_stream() as stream:
        imported = backend.post('/api/imports/commit', {
            **request, 'expected_content_sha256': preview['content_sha256']})
        if imported['contact_id'] != contact_id or imported['imported_count'] != len(records):
            raise ValueError('来源提交的联系人或消息数量不符合本次明确输入。')
        source['commit_response'] = imported
        save_state()
        source['task_result'] = wait_source_task(backend, stream, contact_id=contact_id, task_id=imported['task_id'])
    candidates, cursor, seen_cursors = [], None, set()
    for _ in range(100):
        page = backend.get(f'/api/contacts/{contact_id}/messages?limit=100' + (f'&before={cursor}' if cursor else ''))
        candidates.extend(message for message in page['messages'] if message['text'] == entry['text']
                          and message['speaker'] == 'contact'
                          and message['occurred_at'] is not None
                          and datetime.fromisoformat(message['occurred_at']) == timestamp)
        cursor = page['next_cursor']
        if cursor is None:
            break
        if cursor in seen_cursors:
            raise ValueError('来源消息分页游标重复。')
        seen_cursors.add(cursor)
    else:
        raise ValueError('来源消息超过公开有界分页上限。')
    if len(candidates) != 1:
        raise ValueError('本次来源正文不能唯一映射到实际规范消息。')
    message_id = candidates[0]['message_id']
    sources = backend.get(f'/api/contacts/{contact_id}/sources')['sources']
    matching_sources = [item for item in sources if item['file_name'] == source_path.name and item['status'] == 'active']
    if len(matching_sources) != 1:
        raise ValueError('本次来源记录不能唯一映射到活动公开来源。')
    source.update({'actual_message': candidates[0], 'actual_source': matching_sources[0]})
    pending = backend.get(f'/api/contacts/{contact_id}/memory-candidates')['candidates']
    matches = [item for item in pending if item['text'] == entry['text'] and item['source_ids'] == [message_id]]
    source['matching_pending_candidates'] = matches
    save_state()
    if len(matches) != 1:
        raise ValueError('生产Worker未产生唯一同正文、同消息来源的待确认候选；不得内部补造。')
    if not args.confirm_source_candidates:
        raise ValueError('来源候选已待确认；仅显式 --confirm-source-candidates 沿正式HTTP确认。')
    candidate = matches[0]
    if candidate['status'] != 'pending' or candidate['subject'] != 'contact':
        raise ValueError('来源候选状态或主体不符合已确认联系人范围。')
    path = f'/api/contacts/{contact_id}/memory-candidates/{candidate["candidate_id"]}/confirm'
    memory = backend.post(path, {})['memory']
    source['confirmation'] = {'path': path, 'body': {}, 'response': memory,
                              'actor': 'authorized_synthetic_construction_agent',
                              'human_quality_review': False}
    actual = backend.get(f'/api/contacts/{contact_id}/memories')['memories']
    matches = [item for item in actual if item['memory_id'] == memory['memory_id']]
    if (len(matches) != 1 or matches[0]['source_ids'] != [message_id]
            or matches[0]['revision'] != memory['revision']
            or matches[0]['text'] != entry['text']):
        raise ValueError('实际已采纳资料未保留生产候选及来源消息链。')
    entry['request_fields'] = {'import': request, 'confirm_candidate_id': candidate['candidate_id']}
    save_state()
    return matches[0]

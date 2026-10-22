"""增量画像的内存Markdown工具；场景只读，画像写入仍经独立逐条核验。"""
import json
import re

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from notalone.memory.layered import OrganizationBudgetExhausted
from notalone.memory.scene_workspace import tool_policy, render_scene, tool_schema


def render_profile(profile):
    return '# 长期背景\n\n' + '\n\n'.join('<!-- ENTRY ' + json.dumps({
        **{key: e[key] for key in ('kind', 'section', 'basis') if key in e},
        'temporal_status': e['temporal_status'], 'uncertainty': e['uncertainty'],
        'references': [{key: ref[key] for key in ('memory_id', 'revision')} for ref in e['references']]},
        ensure_ascii=False) + ' -->\n' + e['text'] for e in (profile or {}).get('entries', []))


class ProfileWorkspace:
    def __init__(self, existing, scenarios, budget, *, personal=False):
        self.content = render_profile(existing)
        self.scenes = {s['scenario_id'] + '.md': render_scene(s) for s in scenarios}
        self.budget = budget
        self.personal = personal

    def execute(self, name, args):
        if not isinstance(args, dict) or not isinstance(args.get('path'), str):
            raise ValueError('画像工具参数无效。')
        path = args['path']
        if name == 'read' and set(args) == {'path'}:
            if path == 'profile.md':
                return self.content
            if path in self.scenes:
                return self.scenes[path]
            raise ValueError('只能读取当前冻结范围的画像与场景。')
        if path != 'profile.md':
            raise ValueError('画像工具只能写入profile.md，场景正文只读。')
        if name == 'write' and set(args) == {'path', 'content'}:
            content = args['content']
        elif name == 'edit' and set(args) == {'path', 'edits'}:
            content = self.content
            if not isinstance(args['edits'], list) or not args['edits']:
                raise ValueError('画像编辑须有精确替换。')
            for edit in args['edits']:
                if (not isinstance(edit, dict) or set(edit) != {'oldText', 'newText'}
                        or not isinstance(edit['oldText'], str) or not edit['oldText']
                        or not isinstance(edit['newText'], str) or content.count(edit['oldText']) != 1):
                    raise ValueError('画像编辑须唯一匹配原文。')
                content = content.replace(edit['oldText'], edit['newText'], 1)
        else:
            raise ValueError('画像工具不支持该操作。')
        if not isinstance(content, str) or not content.strip() or len(content) > self.budget.max_characters:
            raise ValueError('画像暂存正文为空或超出预算。')
        self.content = content
        try:
            proposal = self.compile()
            invalid = next((entry for entry in proposal['entries'] if 'invalid_entry' in entry), None)
            if invalid is not None:
                raise ValueError(f"画像条目{invalid['invalid_entry']}：{invalid['reason']}")
        except (ValueError, TypeError, KeyError) as error:
            return '工具错误：' + str(error) + ' 画像已暂存但格式无效，请修正后再结束；尚未发布。'
        return '已暂存画像，等待独立核验。'

    def compile(self):
        if not self.content.startswith('# 长期背景\n'):
            raise ValueError('画像须使用长期背景Markdown格式。')
        body = self.content[len('# 长期背景\n'):].strip()
        if body and not body.startswith('<!-- ENTRY '):
            raise ValueError('画像正文须从条目边界开始。')
        entries = []
        for index, part in enumerate(part for part in re.split(r'(?m)(?=^<!-- ENTRY )', body) if part.strip()):
            try:
                match = re.fullmatch(r'<!-- ENTRY ([^\n]*?) -->\n(.*)', part.strip(), re.S)
                if not match or not match[2].strip():
                    raise ValueError('每条画像正文须绑定时间和来源元数据。')
                meta = json.loads(match[1])
                if not isinstance(meta, dict):
                    raise ValueError('画像条目元数据无效。')
                required = {'temporal_status', 'uncertainty', 'references'}
                allowed = required | {'kind', 'section', 'basis'}
                missing, unknown = required - set(meta), set(meta) - allowed
                if missing or unknown:
                    raise ValueError('画像元数据缺少字段：' + ','.join(sorted(missing))
                        + '；未知字段：' + ','.join(sorted(unknown)) + '。uncertainty即使为空也必须填写。')
                if self.personal and not {'kind', 'section', 'basis'} <= set(meta):
                    raise ValueError('每条个人画像必须填写kind、section和basis。')
                entries.append({**meta, 'text': match[2].strip()})
            except (ValueError, TypeError, KeyError) as error:
                entries.append({'invalid_entry': index, 'reason': str(error)})
        return {'entries': entries}


def validate_incremental_profile(proposal, existing_profile, changed_scenarios):
    """未被变化场景触及的有效旧条目不得静默省略，包括核验过滤后的产物。"""
    if not existing_profile:
        return
    changed = {(r['memory_id'], r['revision']) for scene in changed_scenarios
               for paragraph in scene['paragraphs'] for r in paragraph['references']}
    def identity(entry):
        return (entry['text'], entry['temporal_status'], entry['uncertainty'],
                tuple((key, entry[key]) for key in ('kind', 'section', 'basis') if key in entry),
                tuple(sorted((r['memory_id'], r['revision']) for r in entry['references'])))
    present = {(r['memory_id'], r['revision']) for entry in proposal['entries'] for r in entry['references']}
    required = {(r['memory_id'], r['revision']) for entry in existing_profile['entries'] for r in entry['references']}
    if not required <= present:
        raise ValueError('增量画像不能丢弃仍有效旧条目的来源。')
    actual = {identity(entry) for entry in proposal['entries']}
    for entry in existing_profile['entries']:
        refs = {(r['memory_id'], r['revision']) for r in entry['references']}
        if not refs & changed and identity(entry) not in actual:
            raise ValueError('增量画像遗漏未变化的有效旧条目。')


TOOLS = [tool_schema('read', '读取profile.md或本次目录中场景，不能读取其他范围。', {'path': {'type': 'string'}}),
    tool_schema('write', '覆盖本次暂存profile.md，不能改场景或外部文件。', {'path': {'type': 'string'}, 'content': {'type': 'string'}}),
    tool_schema('edit', '对profile.md进行唯一精确替换。', {'path': {'type': 'string'}, 'edits': {'type': 'array', 'items': {
        'type': 'object', 'properties': {'oldText': {'type': 'string'}, 'newText': {'type': 'string'}},
        'required': ['oldText', 'newText'], 'additionalProperties': False}}})]


def maintain_profile(adapter, *, memories, scenarios, corrections, existing_profile, changed_scenarios,
                     removed_scenario_version_ids, base_profile_version_id, deadline):
    from notalone.memory.organization_sdk import PROFILE_POLICY, CORRECTION_POLICY
    workspace = ProfileWorkspace(existing_profile, scenarios, adapter.budget, personal=adapter.personal)
    profile_policy = PROFILE_POLICY.replace('无合格长期内容就返回空entries。', '无合格长期内容时profile.md仅保留标题。')
    prompt = tool_policy(adapter) + ('' if adapter.personal else profile_policy + CORRECTION_POLICY) + '''\n增量维护长期背景：已有画像有效时保留未受影响条目，依据变化场景补充、更新或合并，清理已撤回依据。
documents是全部可读场景索引，另有始终可读写的profile.md；索引空时不得猜测场景路径，可直接write初始化profile.md。
path仅为索引中的单个xxx.md文件名或profile.md，禁止绝对路径、斜杠和目录。
只使用read/write/edit操作内存profile.md；当前全部场景只读。不得把场景摘要当事实证明，所有条目引用实际memories版本。
profile.md格式：# 长期背景，然后每条<!-- ENTRY {"temporal_status":"uncertain","uncertainty":"当前未核实","references":[{"memory_id":"实际ID","revision":1}]} -->换行完整正文。
标题后的空行后直接开始ENTRY；章节只放在ENTRY的section元数据中，不在条目前后插入额外的##标题或说明段落。
没有合格资料时保留标题和空正文。
最多五轮；最终不调用工具表示提交完整画像给独立核验，第五轮全部工具成功且写入完整合法画像时也会提交核验。不能执行系统命令或访问真实文件。'''
    if adapter.personal:
        from notalone.memory.personal_organization import POLICY, PROFILE_PROMPT
        prompt += PROFILE_PROMPT[len(POLICY):].split('输出{', 1)[0] + '\nENTRY元数据还必须包含kind、section、basis；事实/偏好/推断/矛盾分条，推断及矛盾使用uncertain并保留具体不确定性。'
    payload = {'layer': 'l3', 'mode': 'incremental' if existing_profile else 'first',
        'existing_profile': existing_profile, 'previous_profile': existing_profile,
        'changed_scenarios': list(changed_scenarios), 'changed_scenario_ids': [s['scenario_id'] for s in changed_scenarios],
        'removed_scenario_version_ids': list(removed_scenario_version_ids), 'base_profile_version_id': base_profile_version_id,
        'documents': [{'path': s['scenario_id'] + '.md', 'title': s['title'], 'version_id': s['version_id']} for s in scenarios],
        'memories': [m.to_payload() for m in memories], 'budget': adapter.budget.to_payload(), 'corrections': list(corrections)}
    messages = [SystemMessage(content=prompt), HumanMessage(content=json.dumps(payload, ensure_ascii=False))]
    for _ in range(5):
        deadline.check()
        if sum(len(str(m.content)) for m in messages) > adapter.budget.max_characters:
            raise ValueError('画像工具上下文超出预算。')
        from notalone.application.organization_call import organization_model_request
        with organization_model_request():
            response = adapter.model.bind(tools=TOOLS, max_tokens=min(adapter.budget.max_characters, 8192) if adapter.personal else adapter.budget.max_characters,
                timeout=deadline.remaining_seconds()).invoke(messages)
        deadline.check()
        if response.response_metadata.get('finish_reason') not in {'stop', 'tool_calls'} or getattr(response, 'invalid_tool_calls', []):
            raise ValueError('画像工具输出没有完整结束。')
        messages.append(response)
        if not response.tool_calls:
            # 服务会在结构逐项隔离、独立核验后检查旧条目保全。
            return workspace.compile()
        if len(response.tool_calls) > 8:
            raise ValueError('画像单轮工具数量超限。')
        valid_write = False
        tool_error = False
        for call in response.tool_calls:
            try:
                result = workspace.execute(call['name'], call['args'])
            except ValueError as error:
                result = '工具错误：' + str(error) + ' 请按完整documents索引及profile.md规则纠正。'
            tool_error = tool_error or result.startswith('工具错误：')
            valid_write = valid_write or (call['name'] in {'write', 'edit'} and not result.startswith('工具错误：'))
            messages.append(ToolMessage(content=result, tool_call_id=call['id']))
    deadline.check()
    if valid_write and not tool_error:
        proposal = workspace.compile()
        if not any('invalid_entry' in entry for entry in proposal['entries']):
            # 轮数已用完的完整写入仍须经过服务原有的来源、逐命题和旧条目保全核验。
            return proposal
    raise OrganizationBudgetExhausted()

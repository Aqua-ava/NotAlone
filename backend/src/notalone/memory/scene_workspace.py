"""仅驻内存的范围文档工作区；工具写入经核验后才编译到正式版本协议。"""
import json
import re
from copy import deepcopy

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from notalone.memory.layered import OrganizationBudgetExhausted


def render_scene(scene):
    meta = {key: scene[key] for key in ('title', 'hint')}
    meta['topic_key'] = 'scene-' + scene['scenario_id']
    return '<!-- META ' + json.dumps(meta, ensure_ascii=False) + ' -->\n\n' + '\n\n'.join(
        p['text'] + '\n<!-- SOURCES ' + json.dumps([{key: r[key] for key in ('memory_id', 'revision')}
            for r in p['references']], ensure_ascii=False) + ' -->' for p in scene['paragraphs'])


class SceneWorkspace:
    def __init__(self, scenarios, budget):
        self.budget = budget
        self.original = {s['scenario_id'] + '.md': deepcopy(s) for s in scenarios}
        self.documents = {path: render_scene(s) for path, s in self.original.items()}
        self.baseline = dict(self.documents)
        self.read_paths = set()

    def index(self):
        return [{'path': path, 'scenario_id': s['scenario_id'], 'version_id': s['version_id'],
                 'title': s['title'], 'hint': s['hint']} for path, s in self.original.items()]

    def execute(self, name, args):
        if not isinstance(args, dict):
            raise ValueError('文档工具参数必须是对象。')
        path = args.get('path')
        if not isinstance(path, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,96}\.md', path):
            raise ValueError('只能访问本次工作区内的Markdown文件名。')
        if name == 'read' and set(args) == {'path'}:
            if path not in self.documents:
                raise ValueError('文档不存在。')
            self.read_paths.add(path)
            return self.documents[path]
        if path in self.original and path not in self.read_paths:
            raise ValueError('修改旧文档前须读取其实际正文。')
        if name == 'write' and set(args) == {'path', 'content'}:
            content = args['content']
        elif name == 'edit' and set(args) == {'path', 'edits'}:
            content = self.documents.get(path)
            if content is None or not isinstance(args['edits'], list) or not args['edits']:
                raise ValueError('精确编辑必须有原文及替换列表。')
            for edit in args['edits']:
                if (not isinstance(edit, dict) or set(edit) != {'oldText', 'newText'}
                        or not isinstance(edit['oldText'], str) or not edit['oldText']
                        or not isinstance(edit['newText'], str) or content.count(edit['oldText']) != 1):
                    raise ValueError('编辑片段必须在当前正文中唯一匹配。')
                content = content.replace(edit['oldText'], edit['newText'], 1)
        else:
            raise ValueError('不支持的文档工具或字段。')
        if not isinstance(content, str) or not content.strip() or len(content) > self.budget.max_characters:
            raise ValueError('文档正文超出有限预算或为空。')
        if path not in self.documents and len(self.documents) >= self.budget.max_scenarios * 2:
            raise ValueError('工作区文档数量超出预算。')
        self.documents[path] = content
        return '已暂存，尚未发布。'

    def compile(self):
        outputs, deleted = [], set()
        available = {s['version_id']: path for path, s in self.original.items() if path in self.read_paths}
        for path, content in self.documents.items():
            if content == self.baseline.get(path):
                continue
            if content.strip() == '[DELETED]':
                if path not in self.original:
                    raise ValueError('不能删除不存在的旧文档。')
                deleted.add(self.original[path]['version_id'])
                continue
            match = re.fullmatch(r'<!-- META (.*?) -->\s*(.*)', content, re.S)
            if not match:
                raise ValueError('场景须有META与带来源的Markdown段落。')
            meta, body = json.loads(match[1]), match[2]
            if not isinstance(meta, dict) or set(meta) - {'topic_key', 'title', 'hint', 'replaces'} or not {'topic_key', 'title', 'hint'} <= set(meta):
                raise ValueError('场景META字段无效。')
            replaces = meta.pop('replaces', [])
            if not isinstance(replaces, list) or any(not isinstance(v, str) or v not in available for v in replaces):
                raise ValueError('合并只能引用已读取的本范围版本。')
            if path in self.original:
                replaces = list(dict.fromkeys([self.original[path]['version_id'], *replaces]))
                meta['scenario_id'] = self.original[path]['scenario_id']
            paragraphs = []
            while body.strip():
                part = re.match(r'\s*(.*?)\n<!-- SOURCES (.*?) -->\s*', body, re.S)
                if not part or not part[1].strip():
                    raise ValueError('每段正文须紧跟可校验的来源列表。')
                paragraphs.append({'text': part[1].strip(), 'references': json.loads(part[2])})
                body = body[part.end():]
            outputs.append({**meta, 'replaces': replaces, 'paragraphs': paragraphs})
        replaced = {v for output in outputs for v in output['replaces']}
        if deleted - replaced:
            raise ValueError('软删除必须属于已产出完整正文的合并，不能单独丢弃旧资料。')
        result = {'scenarios': outputs}
        validate_document_replacements(result, tuple(self.original.values()))
        return result


def validate_document_replacements(proposal, scenarios):
    """每个替换产物保留其有效旧依据；过滤核验结果后仍须重新检查。"""
    previous = {s['version_id']: s for s in scenarios}
    for output in proposal['scenarios']:
        present = {(r['memory_id'], r['revision']) for p in output['paragraphs'] for r in p['references']}
        for version in output.get('replaces', []):
            old = previous[version]
            required = {(r['memory_id'], r['revision']) for p in old['paragraphs'] for r in p['references']}
            if not required <= present:
                raise ValueError('场景更新或合并遗漏仍有效的旧来源。')


def tool_schema(name, description, properties):
    return {'type': 'function', 'function': {'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}}}


TOOLS = [tool_schema('read', '读取本次工作区场景正文。', {'path': {'type': 'string'}}),
    tool_schema('write', '创建或覆盖暂存文档；软删除写[DELETED]，仅限合并已读旧场景。',
        {'path': {'type': 'string'}, 'content': {'type': 'string'}}),
    tool_schema('edit', '对已读文档执行唯一精确替换。', {'path': {'type': 'string'}, 'edits': {'type': 'array', 'items': {
        'type': 'object', 'properties': {'oldText': {'type': 'string'}, 'newText': {'type': 'string'}},
        'required': ['oldText', 'newText'], 'additionalProperties': False}}})]


def maintain_scenes(adapter, *, memories, scenarios, corrections, deadline):
    workspace = SceneWorkspace(scenarios, adapter.budget)
    from notalone.memory.organization_sdk import POLICY
    prompt = POLICY + '''\n使用read/write/edit增量维护本工作区Markdown。先读取相关旧文档，更新已有主题、合并重复主题；不要按输入批次新建重复主题。
文档格式：<!-- META {"topic_key":"ascii-key","title":"中文标题","hint":"中文提示","replaces":["被合并旧version_id"]} -->
随后每个完整正文段落紧跟换行<!-- SOURCES [{"memory_id":"实际ID","revision":1}] -->。
更新已有文件自动保留身份并替换旧版本；合并须列出所有旧version_id，读取所有原文，保留仍有效资料和来源，旧文件可写[DELETED]。
仅可用给定memory_id/revision；不得伪造身份、路径、来源。写入仅暂存，最后不调用工具即提交全部变更给独立核验。
最多五轮模型请求；不要创建真实文件、执行命令或读取工作区外内容。'''
    messages = [SystemMessage(content=prompt), HumanMessage(content=json.dumps({'layer': 'l2', 'memories': [m.to_payload() for m in memories],
        'documents': workspace.index(), 'corrections': list(corrections)}, ensure_ascii=False))]
    for _ in range(5):
        deadline.check()
        if sum(len(str(m.content)) for m in messages) > adapter.budget.max_characters:
            raise ValueError('文档工具上下文超过预算。')
        response = adapter.model.bind(tools=TOOLS, max_tokens=adapter.budget.max_characters,
                                      timeout=deadline.remaining_seconds()).invoke(messages)
        deadline.check()
        if response.response_metadata.get('finish_reason') not in {'stop', 'tool_calls'} or getattr(response, 'invalid_tool_calls', []):
            raise ValueError('文档工具模型输出未完整结束。')
        messages.append(response)
        if not response.tool_calls:
            return workspace.compile()
        if len(response.tool_calls) > 8:
            raise ValueError('单轮文档工具数量超限。')
        for call in response.tool_calls:
            result = workspace.execute(call['name'], call['args'])
            messages.append(ToolMessage(content=result, tool_call_id=call['id']))
    raise OrganizationBudgetExhausted()

"""仅从stdin接收合成身份，使用真实RemoteReplyPort解码官方TS生成结果。"""
import json
import sys
from dataclasses import asdict, replace
from uuid import UUID
from urllib.parse import urlsplit

from notalone.application.reply_remote import RemoteReplyPort
from notalone.reply.interface import GenerateReply, RewriteDraft, NoSkill
from notalone.reply.input_budget import InputBudgetExceededError
from notalone.scopes import ContactScope, VerifiedConversationScope

config = json.loads(sys.stdin.readline())
endpoint = urlsplit(config['url'])
def allow_synthetic_network(event, args):
    if event == 'socket.connect':
        address = args[1]
        if not isinstance(address, tuple) or address[:2] != ('127.0.0.1', endpoint.port):
            raise AssertionError('合成Python薄桥禁止连接白名单以外地址')
        print('PYTHON_NETWORK ' + json.dumps({'host': address[0], 'port': address[1]}), file=sys.stderr, flush=True)
sys.addaudithook(allow_synthetic_network)
scope = VerifiedConversationScope(*(UUID(config[key]) for key in ('owner_id', 'contact_id', 'conversation_binding_id')))
command = GenerateReply(UUID(config['idempotency_key']), ContactScope(scope.owner_id, scope.contact_id),
    scope.conversation_binding_id, RewriteDraft('明天见'), skill=NoSkill())
remote = RemoteReplyPort(url=config['url'], token=config['token'], owner_id=scope.owner_id)
first = None
try:
    for line in sys.stdin:
        operation = json.loads(line)
        try:
            if operation['operation'] == 'prepare':
                assert remote.prepare(command, verified_scope=scope) is None
                value = {'ok': True, 'prepared': True}
            elif operation['operation'] in ('generate', 'replay'):
                result = remote.generate(command, verified_scope=scope)
                if first is None:
                    first = result
                else:
                    assert result == first, '重放不得改变任何原DTO身份/正文'
                value = {'ok': True, 'reply': asdict(result)}
            elif operation['operation'] == 'oversized':
                remote.generate(replace(command, idempotency_key=UUID(operation['key']), content=RewriteDraft('合成' * 20000)),
                    verified_scope=scope)
                raise AssertionError('超长输入不能发往模型')
            elif operation['operation'] == 'bad_binding':
                binding = UUID(operation['binding'])
                remote.generate(replace(command, idempotency_key=UUID(operation['key']), conversation_binding_id=binding),
                    verified_scope=replace(scope, conversation_binding_id=binding))
                raise AssertionError('不存在的真实绑定不能生成')
            else:
                raise AssertionError('合成测试操作无效')
        except InputBudgetExceededError as error:
            value = {'ok': False, 'error': type(error).__name__, 'input_budget': error.decision.to_payload()}
        except Exception as error:
            value = {'ok': False, 'error': type(error).__name__}
        print(json.dumps(value, default=str, ensure_ascii=False), flush=True)
finally:
    remote.close()

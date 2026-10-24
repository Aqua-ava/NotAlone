"""TS 探索业务的认证薄桥；仅将已验证命令交还既有 A 生成端口。"""
from __future__ import annotations

import http.client
import json
import socket
import threading
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from notalone.application.assistant_session_service import (
    AssistantSessionConflict, AssistantSessionNotFound, AssistantSessionRejected,
)
from notalone.application.manual_input_scope import manual_input_contact
from notalone.persistence.locks import lock_owner_scope

from notalone.application.reply_remote import RemoteReplyPort, _json_pairs
from notalone.reply.errors import ReplyInvariantError, ReplyRunError
from notalone.reply.exploration import ExplorationError, ExplorationExpired, ExplorationStale
from notalone.reply.exploration_task import ExplorationGeneration
from notalone.reply.interface import DirectionSource, NoSkill, UserSkillChoice


def _wire(value):
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, dict):
        return {key: _wire(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_wire(item) for item in value]
    return value


class _RemoteRequestInvalid(ValueError):
    pass


class PostgresExplorationCommandReader:
    """同 owner 事务内只读重建 A 命令；过期清理完全由 TS 负责。"""

    def __init__(self, *, database_url, store):
        self._database_url, self._store = database_url, store

    def __call__(self, scope, exploration_id):
        try:
            with psycopg.connect(self._database_url, row_factory=dict_row) as connection:
                lock_owner_scope(connection, owner_id=scope.owner_id)
                return self._store.read_in_transaction(connection, scope, exploration_id)
        except ExplorationExpired:
            # 不进入原 store._transaction：其异常分支会另开事务擦除 B。
            raise ExplorationStale('探索任务已超过原有效期，请明确开启新任务。') from None
        except (AssistantSessionNotFound, AssistantSessionConflict, AssistantSessionRejected):
            raise ExplorationStale('探索输入、绑定或原始来源已经变化。') from None
        except psycopg.Error:
            raise ExplorationError('探索资料未可靠读取，请手动重试。') from None


class RemoteExplorationService:
    """不执行 B 选择、不写 B 表，不重试任何未知结果的调用。"""

    def __init__(self, *, url, token, owner_id, store, generation, timeout=60, read_command=None):
        # 沿用同宿主的回环地址、认证 token 和连接生命周期约束。
        self._transport = RemoteReplyPort(url=url, token=token, owner_id=owner_id, timeout=timeout)
        self._owner, self._store, self._generation = owner_id, store, generation
        self._read_command = read_command or PostgresExplorationCommandReader(
            database_url=store._database_url, store=store,
        )

    @classmethod
    def from_environment(cls, environment, *, owner_id, store, generation, read_command=None):
        return cls(url=environment['NOTALONE_REPLY_REMOTE_URL'],
                   token=environment['NOTALONE_REPLY_REMOTE_TOKEN'], owner_id=owner_id,
                   store=store, generation=generation, read_command=read_command)

    def open(self, *, scope, session_id, content, **request):
        return self._request(scope, 'open', {'content': content.payload(), **request}, session_id)

    def read(self, *, scope, exploration_id):
        return self._request(scope, 'read', {'exploration_id': exploration_id})

    def require_session(self, *, scope, session_id, exploration_id):
        self._request(scope, 'require_session', {'exploration_id': exploration_id}, session_id)

    def reconfirm(self, *, scope, session_id, **request):
        return self._request(scope, 'reconfirm', request, session_id)

    def stop(self, *, scope, exploration_id, input_version_id):
        task = self._read_command(scope, exploration_id)
        if (task.scope != scope or task.exploration_id != exploration_id
                or task.input_version_id != input_version_id):
            raise ExplorationStale('停止操作不属于当前探索输入。')
        self._request(scope, 'stop', {'exploration_id': exploration_id,
                                    'input_version_id': input_version_id}, task.session_id)

    def confirm(self, *, scope, session_id=None, prepare_only=False, selection_only=False, **request):
        return self._select(scope, session_id, 'confirm', request, prepare_only, selection_only)

    def answer(self, *, scope, session_id=None, prepare_only=False, selection_only=False, **request):
        return self._select(scope, session_id, 'answer', request, prepare_only, selection_only)

    def _select(self, scope, session_id, action, request, prepare_only, selection_only):
        result = self._request(scope, action, {**request, 'prepare_only': prepare_only,
                                               'selection_only': selection_only}, session_id)
        kind = result.get('kind')
        if kind not in ('generation_command', 'replay_command'):
            return result
        if selection_only:
            raise ReplyInvariantError('exploration_remote_invalid_response')
        try:
            exploration_id = UUID(result['exploration_id'])
        except (KeyError, ValueError, TypeError):
            raise ReplyInvariantError('exploration_remote_invalid_response') from None
        if kind == 'replay_command':
            if session_id is None:
                raise ExplorationStale('探索重放缺少助手会话。')
            replay = self._store.replay_confirmation if action == 'confirm' else self._store.replay_answer
            fields = ('suggestion_id', 'direct_intent') if action == 'confirm' else ('question_id', 'answer', 'operation_key')
            completed = replay(scope, session_id, request['exploration_id'], request['input_version_id'],
                               **{key: request.get(key) for key in fields})
            if completed is None or completed.exploration_id != exploration_id:
                raise ExplorationStale('探索重放没有已完成的原请求。')
            if prepare_only:
                receipt = self._generation.prepare_replay(scope, session_id, completed)
                return {'kind': 'prepared', 'exploration_id': str(exploration_id), 'generation': receipt}
            turn = self._generation.replay(scope, session_id, completed)
            content = completed.input_payload['content']
            intent = content['direction'] if content['type'] == 'reply_to_message' else content['purpose']
        else:
            task = self._read_command(scope, exploration_id)
            if (task.scope != scope or session_id is not None and task.session_id != session_id
                    or str(task.input_version_id) != result.get('input_version_id')
                    or str(task.request_key) != result.get('request_key')
                    or task.selected_intent != result.get('confirmed_intent')
                    or not task.has_confirmed_intent or task.state not in ('selected', 'confirmed')
                    or not isinstance(task.selection_source, DirectionSource)):
                raise ExplorationStale('探索生成命令与可靠保存的选择不一致。')
            command = ExplorationGeneration(task, task.selected_intent, task.selection_source,
                                            UserSkillChoice(task.skill_version_id) if task.skill_version_id else NoSkill())
            if prepare_only:
                receipt = self._generation.prepare(command)
                return {'kind': 'prepared', 'exploration_id': str(exploration_id), 'generation': receipt}
            turn = self._generation.generate(command)
            self._request(scope, 'finish', {'exploration_id': exploration_id,
                                           'input_version_id': task.input_version_id,
                                           'request_key': task.request_key}, task.session_id)
            intent = task.selected_intent
        return {'kind': 'generated', 'exploration_id': str(exploration_id), 'turn': turn,
                'confirmed_intent': intent}

    def _request(self, scope, action, request, session_id=None):
        if scope.owner_id != self._owner:
            raise ExplorationStale('探索不属于当前用户。')
        manual_contact = manual_input_contact.get()
        if manual_contact is not None and manual_contact != scope.contact_id:
            raise ExplorationStale('手动输入不属于当前联系人。')
        payload = _wire({'owner_id': scope.owner_id, 'contact_id': scope.contact_id,
                         'manual_input': manual_contact is not None,
                         **({'session_id': session_id} if session_id is not None else {}),
                         'action': action, 'request': request})
        transport = self._transport
        connection = http.client.HTTPConnection('127.0.0.1', transport._port, timeout=transport._timeout)
        connection.auto_open = 0
        with transport._lock:
            if transport._closed:
                raise ReplyRunError('exploration_remote_unavailable')
            transport._connections.add(connection)
        expired = threading.Event()

        def interrupt():
            expired.set()
            if connection.sock is not None:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()

        timer = threading.Timer(transport._timeout, interrupt)
        timer.daemon = True
        timer.start()
        try:
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            if len(encoded) > 1048576:
                raise ValueError()
            connection.connect()
            with transport._lock:
                if transport._closed or expired.is_set():
                    raise OSError()
            connection.request('POST', '/internal/exploration', body=encoded,
                               headers={'Authorization': 'Bearer ' + transport._token,
                                        'Content-Type': 'application/json'})
            response = connection.getresponse()
            body = response.read(1048577)
            if len(body) > 1048576 or response.getheader('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise ReplyInvariantError('exploration_remote_invalid_response')
            result = json.loads(body, object_pairs_hook=_json_pairs,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if response.status != 200:
                if type(result) is not dict:
                    raise ReplyInvariantError('exploration_remote_invalid_response')
                if result.get('error') == 'exploration_rejected' and 'input_budget' in result:
                    budget = result['input_budget']
                    state = budget.get('state') if type(budget) is dict else None
                    if state not in ('exceeded', 'unavailable'):
                        raise ReplyInvariantError('exploration_remote_invalid_response')
                    RemoteReplyPort._raise_remote_error({**result, 'error': 'input_budget_' + state})
                if result.get('error') in ('exploration_rejected', 'exploration_stale', 'exploration_expired'):
                    raise ExplorationError('探索请求已失效。')
                if result.get('error') == 'exploration_request_invalid':
                    raise _RemoteRequestInvalid('exploration_request_invalid')
                RemoteReplyPort._raise_remote_error(result)
            if (type(result) is not dict or result.get('owner_id') != payload['owner_id']
                    or result.get('contact_id') != payload['contact_id'] or type(result.get('result')) is not dict):
                raise ReplyInvariantError('exploration_remote_invalid_response')
            with transport._lock:
                if transport._closed or expired.is_set():
                    raise OSError()
            return result['result']
        except (OSError, http.client.HTTPException, UnicodeError):
            raise ReplyRunError('exploration_remote_unavailable') from None
        except _RemoteRequestInvalid:
            raise
        except (ValueError, TypeError):
            raise ReplyInvariantError('exploration_remote_invalid_response') from None
        finally:
            timer.cancel()
            with transport._lock:
                transport._connections.discard(connection)
            connection.close()

    def close(self):
        self._transport.close()

"""迁移期ReplyPort薄桥：只调用认证TS服务，不检索、不生成、不自动重试。"""
from __future__ import annotations

import http.client
import json
import socket
import threading
from typing import Mapping
from urllib.parse import urlsplit
from uuid import UUID

from notalone.scopes import VerifiedConversationScope
from notalone.reply.interface import (
    GenerateReply, ReplyToMessage, InitiateConversation, RewriteDraft, NoSkill, UserSkillChoice,
    ReplyGenerated, ReplyCandidate, CandidateMessage, ContextReceipt, ExpressionPreferenceReceipt,
    SkillUse, ReplyBasisChange,
)
from notalone.reply.assistant_continuation_reference import ContinuationGenerateReply
from notalone.reply.input_budget import (
    InputBudgetDecision, BudgetState, TokenMeasurementKind, InputBudgetExceededError, InputBudgetUnavailableError,
)
from notalone.reply.errors import (
    ReplyRunError, ReplyInvariantError, ReplyInputInvalidatedError, ReplyIdempotencyConflictError,
    ReplyInProgressError, ReplyContinuationError, ReplyExpressionPreferencesChangedError,
    ReplyCandidatesRejectedError, ReplyReviewInvalidError, ReplyTimeoutError, ReplyBudgetError,
    ReplyContextError, ReplyContextInvariantError, ReplyPersistenceError, ReplyProviderContextLimitError,
)
from notalone.skills.models import SkillExecutionView
from notalone.application.assistant_session_service import AssistantSessionRejected


class ReplyRemoteRejected(AssistantSessionRejected):
    """原ReplyServiceResult.reason；应用入口须恢复为拒绝结果，不能伪装生成故障。"""


_REJECTION_REASONS = frozenset({
    "scope_mismatch", "no_active_binding", "manual_contact_unconfirmed", "invalid_verification",
    "history_sync_pending", "history_incomplete_confirmation_required",
})


class ReplyRemoteUnavailable(ReplyRunError):
    def __init__(self):
        super().__init__("reply_remote_unavailable")


class ReplyRemoteInvalidResponse(ReplyInvariantError):
    def __init__(self):
        super().__init__("reply_remote_invalid_response")


def _object(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise ValueError()
    return value


def _uuid(value):
    if type(value) is not str or str(UUID(value)) != value:
        raise ValueError()
    return UUID(value)


def _text(value, *, blank=False, limit=65536):
    if type(value) is not str or len(value) > limit or not blank and not value.strip():
        raise ValueError()
    return value


def _ids(values):
    if type(values) is not list or len(values) > 10000:
        raise ValueError()
    result = tuple(_uuid(v) for v in values)
    if len(set(result)) != len(result):
        raise ValueError()
    return result


def _integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= 9223372036854775807:
        raise ValueError()
    return value


def _budget(value):
    _object(value, ('state', 'allowed', 'model_id', 'context_window_tokens', 'input_tokens',
                    'output_reserve_tokens', 'total_tokens', 'measurement_kind', 'measurement_id', 'reason'),
            ('safety_margin_tokens',))
    state = BudgetState(value['state'])
    if type(value['allowed']) is not bool or value['allowed'] != (state in (BudgetState.READY, BudgetState.WARNING)):
        raise ValueError()
    counts = {key: _integer(value[key]) if value[key] is not None else None for key in
              ('context_window_tokens', 'input_tokens', 'output_reserve_tokens', 'total_tokens')}
    kind = TokenMeasurementKind(value['measurement_kind']) if value['measurement_kind'] is not None else None
    measurement = _text(value['measurement_id'], limit=256) if value['measurement_id'] is not None else None
    reason = _text(value['reason'], limit=256) if value['reason'] is not None else None
    safety = _integer(value.get('safety_margin_tokens', 0))
    if value['allowed'] and (None in counts.values() or kind is None or measurement is None
            or counts['total_tokens'] != counts['input_tokens'] + counts['output_reserve_tokens'] + safety
            or counts['total_tokens'] > counts['context_window_tokens']
            or kind == TokenMeasurementKind.APPROXIMATE and safety < 1):
        raise ValueError()
    return InputBudgetDecision(state, _text(value['model_id'], limit=256), **counts,
        measurement_kind=kind, measurement_id=measurement, reason=reason, safety_margin_tokens=safety)


def decode_reply_generated(value: object, scope: VerifiedConversationScope) -> ReplyGenerated:
    """严格恢复原DTO，不丢候选消息身份、历史执行凭证或大整数修订。"""
    try:
        _object(value, ('reply_request_id', 'candidates', 'context_receipt', 'used_skill'), ('input_budget', 'basis_changes'))
        raw = _object(value['context_receipt'], ('evidence_ids', 'expression_preference_ids', 'expression_preferences'),
                      ('layered_read_failed', 'owner_layered_read_failed', 'overview_read_failed'))
        evidence, preference_ids = _ids(raw['evidence_ids']), _ids(raw['expression_preference_ids'])
        if type(raw['expression_preferences']) is not list or len(raw['expression_preferences']) > 5:
            raise ValueError()
        preferences = []
        for item in raw['expression_preferences']:
            _object(item, ('preference_id', 'text', 'revision', 'scope'))
            item_scope = _object(item['scope'], ('contact_id', 'reply_mode'))
            contact = _uuid(item_scope['contact_id']) if item_scope['contact_id'] is not None else None
            if contact is not None and contact != scope.contact_id:
                raise ValueError()
            preferences.append(ExpressionPreferenceReceipt(_uuid(item['preference_id']), _text(item['text'], limit=512),
                _integer(item['revision'], 1), contact, item_scope['reply_mode']))
        if tuple(p.preference_id for p in preferences) != preference_ids or sum(len(p.text) for p in preferences) > 1536:
            raise ValueError()
        flags = {key: raw.get(key, False) for key in ('layered_read_failed', 'owner_layered_read_failed', 'overview_read_failed')}
        if any(type(v) is not bool for v in flags.values()):
            raise ValueError()
        context = ContextReceipt(evidence, preference_ids, tuple(preferences), **flags)
        if type(value['candidates']) is not list or not 1 <= len(value['candidates']) <= 3:
            raise ValueError()
        candidates = []
        for item in value['candidates']:
            _object(item, ('candidate_id', 'text', 'basis', 'citation_ids', 'risk_notes'), ('messages',))
            citations = _ids(item['citation_ids'])
            if not set(citations) <= set(evidence) or type(item['risk_notes']) is not list:
                raise ValueError()
            messages = []
            if 'messages' in item:
                if type(item['messages']) is not list or not 1 <= len(item['messages']) <= 8:
                    raise ValueError()
                for message in item['messages']:
                    _object(message, ('message_id', 'text'))
                    messages.append(CandidateMessage(_uuid(message['message_id']), _text(message['text'])))
                if len({m.message_id for m in messages}) != len(messages):
                    raise ValueError()
            candidates.append(ReplyCandidate(_uuid(item['candidate_id']), _text(item['text']), _text(item['basis']), citations,
                tuple(_text(note) for note in item['risk_notes']), tuple(messages)))
        if len({c.candidate_id for c in candidates}) != len(candidates):
            raise ValueError()
        skill = None
        if value['used_skill'] is not None:
            item = _object(value['used_skill'], ('skill_id', 'version_id', 'name', 'selection_method', 'selection_reason',
                'resource_paths', 'load_state', 'version_number', 'scope'), ('execution_view',))
            target = _object(item['scope'], ('kind', 'contact_id', 'scene'))
            if target['kind'] not in ('owner', 'contact', 'scene'):
                raise ValueError()
            contact = _uuid(target['contact_id']) if target['contact_id'] is not None else None
            scene = _text(target['scene'], limit=256) if target['scene'] is not None else None
            if (contact is not None and contact != scope.contact_id
                    or target['kind'] == 'contact' and (contact is None or scene is not None)
                    or target['kind'] == 'owner' and (contact is not None or scene is not None)
                    or target['kind'] == 'scene' and scene is None):
                raise ValueError()
            if type(item['resource_paths']) is not list:
                raise ValueError()
            view = SkillExecutionView.from_payload(item['execution_view']) if item.get('execution_view') is not None else None
            skill = SkillUse(_uuid(item['skill_id']), _uuid(item['version_id']), _text(item['name'], limit=256),
                item['selection_method'], _text(item['selection_reason'], blank=True), tuple(_text(p, limit=4096) for p in item['resource_paths']),
                item['load_state'], _integer(item['version_number'], 1) if item['version_number'] is not None else None,
                target['kind'], contact, scene, view)
        changes = value.get('basis_changes', [])
        if type(changes) is not list:
            raise ValueError()
        basis = []
        for change in changes:
            _object(change, ('evidence_id', 'kind', 'reason'))
            basis.append(ReplyBasisChange(_uuid(change['evidence_id']), change['kind'], change['reason']))
        budget = _budget(value['input_budget']) if value.get('input_budget') is not None else None
        if budget is not None and not budget.allowed:
            raise ValueError()
        return ReplyGenerated(_uuid(value['reply_request_id']), tuple(candidates), context, skill, budget, tuple(basis))
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise ReplyRemoteInvalidResponse() from None


def reply_remote_payload(command: GenerateReply, verified_scope: VerifiedConversationScope, owner_id: UUID) -> dict:
    """可信续写上下文只进入私有信道envelope，绝不混入公开request JSON。"""
    if not isinstance(command, GenerateReply) or not isinstance(verified_scope, VerifiedConversationScope) or owner_id != verified_scope.owner_id or not command.matches_verified_scope(verified_scope) or not command.has_valid_content() or not isinstance(command.idempotency_key, UUID) or type(command.allow_incomplete_history) is not bool:
        raise ReplyInvariantError('reply_remote_scope_mismatch')
    content = command.content
    if isinstance(content, RewriteDraft):
        body = {'type': 'rewrite_draft', **{key: getattr(content, key) for key in
            ('draft_text', 'user_instruction', 'include_relationship_context', 'input_kind', 'pasted_direction', 'workspace_action', 'context_text')}}
        body['excluded_message_ids'] = [str(v) for v in content.excluded_message_ids]
        direction = None
    else:
        field = 'direction' if isinstance(content, ReplyToMessage) else 'purpose'
        direction = getattr(content, field)
        body = {'type': 'reply_to_message' if field == 'direction' else 'initiate_conversation',
                field: str(direction.text), field + '_source': direction.source.value,
                **{key: str(getattr(content, key)) if getattr(content, key) is not None else None for key in
                   ('understanding_correction', 'user_instruction', 'clarification_answer')}}
        if field == 'direction':
            body['target_message_id'] = str(content.target_message_id)
    request = {'contact_id': str(command.scope.contact_id), 'idempotency_key': str(command.idempotency_key),
        'content': body, 'continued_from_candidate_id': str(command.continued_from_candidate_id) if command.continued_from_candidate_id else None,
        'skill_version_id': str(command.skill.version_id) if isinstance(command.skill, UserSkillChoice) else None,
        'skill_disabled': isinstance(command.skill, NoSkill), 'scene': command.scene,
        'allow_incomplete_history': command.allow_incomplete_history}
    if direction is not None and direction.suggestion is not None:
        ref = direction.suggestion
        if not isinstance(ref.input_version, UUID):
            raise ReplyInvariantError('reply_remote_suggestion_unverified')
        request['suggestion'] = {key: str(getattr(ref, key)) for key in ('task_id', 'input_version', 'suggestion_id')}
    internal = {}
    if isinstance(command, ContinuationGenerateReply):
        ref = command.continuation_reference
        internal['authenticatedContinuation'] = {'continuation': command.continuation,
            'continuation_reference': None if ref is None else {'candidate_id': str(ref.candidate_id), 'version_id': str(ref.version_id),
                'messages': [{'message_id': str(m.message_id), 'text': m.text} for m in ref.messages]}}
    return {'verified_scope': {key: str(getattr(verified_scope, key)) for key in ('owner_id', 'contact_id', 'conversation_binding_id')},
            'request': request, 'internal': internal}


def _json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


class RemoteReplyPort:
    def __init__(self, *, url: str, token: str, owner_id: UUID, timeout: float = 30):
        try:
            parsed = urlsplit(url)
            valid = (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1' and parsed.port is not None and 1 <= parsed.port <= 65535
                     and not parsed.username and not parsed.password and not parsed.path and not parsed.query and not parsed.fragment)
        except ValueError:
            valid = False
        if not valid or type(token) is not str or len(token) < 32 or any(ord(c) < 33 or ord(c) > 126 for c in token) or not isinstance(owner_id, UUID) or type(timeout) not in (int, float) or not 0 < timeout <= 120:
            raise ValueError('reply_remote_config_invalid')
        self._port, self._token, self._owner, self._timeout = parsed.port, token, owner_id, timeout
        self._lock, self._closed, self._connections = threading.Lock(), False, set()

    @classmethod
    def from_environment(cls, environment: Mapping[str, str], *, owner_id: UUID):
        try:
            return cls(url=environment['NOTALONE_REPLY_REMOTE_URL'], token=environment['NOTALONE_REPLY_REMOTE_TOKEN'], owner_id=owner_id)
        except (KeyError, ValueError, TypeError):
            raise ReplyRemoteUnavailable() from None

    def prepare(self, command: GenerateReply, *, verified_scope: VerifiedConversationScope) -> None:
        result = self._request('prepare', reply_remote_payload(command, verified_scope, self._owner))
        try:
            _object(result, ('verified_scope', 'prepared'), ('receipt', 'input_budget'))
            if result.get('receipt') is not None and type(result['receipt']) is not dict:
                raise ValueError()
            if result.get('input_budget') is not None and not _budget(result['input_budget']).allowed:
                raise ValueError()
            if result['prepared'] is not True:
                raise ValueError()
        except (ValueError, TypeError):
            raise ReplyRemoteInvalidResponse() from None

    def generate(self, command: GenerateReply, *, verified_scope: VerifiedConversationScope) -> ReplyGenerated:
        result = self._request('generate', reply_remote_payload(command, verified_scope, self._owner))
        try:
            _object(result, ('verified_scope', 'reply'))
        except (ValueError, TypeError):
            raise ReplyRemoteInvalidResponse() from None
        return decode_reply_generated(result['reply'], verified_scope)

    def _request(self, operation: str, payload: dict) -> dict:
        connection = http.client.HTTPConnection('127.0.0.1', self._port, timeout=self._timeout)
        connection.auto_open = 0
        with self._lock:
            if self._closed:
                raise ReplyRemoteUnavailable()
            self._connections.add(connection)
        expired = threading.Event()
        def interrupt():
            expired.set()
            if connection.sock is not None:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()
        timer = threading.Timer(self._timeout, interrupt)
        timer.daemon = True
        timer.start()
        try:
            encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
            if len(encoded) > 1048576:
                raise ValueError()
            connection.connect()
            with self._lock:
                if self._closed or expired.is_set():
                    raise ReplyRemoteUnavailable()
            connection.request('POST', '/internal/reply/' + operation, body=encoded,
                               headers={'Authorization': 'Bearer ' + self._token, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            body = response.read(1048577)
            if len(body) > 1048576 or response.getheader('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise ReplyRemoteInvalidResponse()
            result = json.loads(body, object_pairs_hook=_json_pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if response.status != 200:
                self._raise_remote_error(result, operation)
            if type(result) is not dict or result.get('verified_scope') != payload['verified_scope']:
                raise ReplyRemoteInvalidResponse()
            with self._lock:
                if self._closed or expired.is_set():
                    raise ReplyRemoteUnavailable()
            return result
        except (OSError, http.client.HTTPException, ValueError, TypeError, UnicodeError):
            raise ReplyRemoteUnavailable() from None
        finally:
            timer.cancel()
            with self._lock:
                self._connections.discard(connection)
            connection.close()

    @staticmethod
    def _raise_remote_error(result, operation="generate"):
        if type(result) is not dict or type(result.get('error')) is not str:
            raise ReplyRemoteInvalidResponse()
        code = result['error']
        errors = {'reply_input_invalidated': ReplyInputInvalidatedError, 'reply_input_conflict': ReplyIdempotencyConflictError,
            'reply_in_progress': ReplyInProgressError, 'reply_continuation_invalid': ReplyContinuationError,
            'expression_preferences_changed': ReplyExpressionPreferencesChangedError, 'reply_candidates_rejected': ReplyCandidatesRejectedError,
            'reply_review_invalid': ReplyReviewInvalidError, 'reply_timeout': ReplyTimeoutError, 'reply_budget_exceeded': ReplyBudgetError,
            'reply_budget_unavailable': ReplyBudgetError, 'reply_context_invalidated': ReplyContextInvariantError,
            'reply_context_unavailable': ReplyContextError, 'reply_generation_failed': ReplyRunError,
            'reply_persistence_unavailable': ReplyPersistenceError}
        if code == 'reply_rejected':
            reason = result.get('reason')
            if type(reason) is not str or reason not in _REJECTION_REASONS:
                raise ReplyRemoteInvalidResponse()
            raise ReplyRemoteRejected(reason)
        if code in ('exploration_stale', 'exploration_expired'):
            raise AssistantSessionRejected(code)
        if code in ('reply_cancelled', 'runtime_stopping'):
            if operation == 'prepare':
                from notalone.application.assistant_preparation_control import AssistantPreparationStopped
                raise AssistantPreparationStopped('cancelled' if code == 'reply_cancelled' else 'runtime_stopping')
            from notalone.application.model_priority import ModelWorkStopped
            raise ModelWorkStopped(code)
        if code == 'provider_context_limit':
            raise ReplyProviderContextLimitError()
        if code in ('input_budget_exceeded', 'input_budget_unavailable'):
            try:
                budget = _budget(result['input_budget'])
                if budget.state != (BudgetState.EXCEEDED if code == 'input_budget_exceeded' else BudgetState.UNAVAILABLE):
                    raise ValueError()
            except (ValueError, KeyError, TypeError):
                raise ReplyRemoteInvalidResponse() from None
            raise (InputBudgetExceededError if code == 'input_budget_exceeded' else InputBudgetUnavailableError)(budget)
        if code in errors:
            raise errors[code](code)
        raise ReplyRemoteUnavailable()

    def close(self):
        with self._lock:
            self._closed = True
            connections = tuple(self._connections)
        for connection in connections:
            if connection.sock is not None:
                try:
                    connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
            connection.close()

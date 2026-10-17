"""联系人待审核草稿仅经用户审核发布；模型不持有管理权限。"""

import json
from uuid import UUID

import psycopg

from notalone.application.model_priority import ModelWorkStopped
from notalone.persistence.skill_learning import SkillLearningNotFound
from notalone.scopes import ContactScope
from notalone.server.sync_host import SyncHostStopped
from notalone.skills.learning import SkillLearningInvalid, SkillLearningUnavailable
from notalone.skills.review import publication_scope, review_input


def _draft_command(parts, method, body, scope):
    if len(parts) not in (6, 7) or parts[4] != 'drafts':
        return None
    draft_id = UUID(parts[5])
    if len(parts) == 6:
        return ('read_draft', {'draft_id': draft_id}) if method == 'GET' else None
    action = parts[6]
    if method != 'POST' or action not in ('edit', 'compare', 'approve', 'decision'):
        return None
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError()
    common = {'expected_revision', 'operation_key'}
    if (type(payload.get('expected_revision')) is not int or payload['expected_revision'] < 1
            or not isinstance(payload.get('operation_key'), str)):
        raise ValueError()
    command = {'draft_id': draft_id, 'expected_revision': payload['expected_revision'],
               'operation_key': UUID(payload['operation_key'])}
    if action == 'edit' and set(payload) == common | {'strategy'}:
        if not isinstance(payload['strategy'], dict):
            raise ValueError()
        command['strategy'] = payload['strategy']
    elif action == 'compare' and set(payload) == common | {'input', 'scope'}:
        command['input'] = review_input(payload['input'])
        command['scope_confirmation'] = publication_scope(payload['scope'], scope.contact_id,
                                                         scene=command['input']['scene'])
    elif (action == 'approve' and set(payload) == common | {
            'comparison_id', 'scope', 'confirmed', 'replacements_confirmed'}
            and payload['confirmed'] is True and payload['replacements_confirmed'] is True):
        if not isinstance(payload['comparison_id'], str):
            raise ValueError()
        command['comparison_id'] = UUID(payload['comparison_id'])
        command['scope_confirmation'] = publication_scope(payload['scope'], scope.contact_id)
    elif action == 'decision' and set(payload) == common | {'decision'} and payload['decision'] in ('reject', 'defer'):
        command['decision'] = payload['decision']
    else:
        raise ValueError()
    return ('review_' + action, command)


def _history_command(parts, method, body):
    if parts[4] != 'skills' or len(parts) not in (5, 6, 7):
        return None
    skill_id = UUID(parts[5]) if len(parts) > 5 else None
    if len(parts) < 7 and method == 'GET':
        return 'skill_history', {'skill_id': skill_id}
    if len(parts) != 7 or parts[6] != 'rollback' or method != 'POST':
        return None
    payload = json.loads(body)
    if (not isinstance(payload, dict) or set(payload) != {'version_id', 'expected_revision', 'expected_current_version_id', 'operation_key'}
            or type(payload['expected_revision']) is not int or payload['expected_revision'] < 0
            or not all(isinstance(payload[key], str) for key in ('version_id', 'operation_key'))
            or not (payload['expected_current_version_id'] is None or isinstance(payload['expected_current_version_id'], str))):
        raise ValueError()
    return 'rollback_skill', {'skill_id': skill_id, 'version_id': UUID(payload['version_id']),
        'expected_revision': payload['expected_revision'], 'expected_current_version_id': UUID(payload['expected_current_version_id']) if payload['expected_current_version_id'] is not None else None,
        'operation_key': UUID(payload['operation_key'])}


def _policy_command(parts, method, body, scope):
    if len(parts) == 7 and parts[6] == 'undo' and method == 'POST':
        payload = json.loads(body)
        if (not isinstance(payload, dict) or set(payload) != {'expected_revision', 'operation_key'}
                or type(payload['expected_revision']) is not int or payload['expected_revision'] < 0
                or not isinstance(payload['operation_key'], str)):
            raise ValueError()
        return 'undo_skill_policy', {'policy_id': UUID(parts[5]), 'expected_revision': payload['expected_revision'],
            'operation_key': UUID(payload['operation_key'])}
    if len(parts) != 5:
        return None
    if method == 'GET':
        return 'skill_policies', {}
    if method != 'POST':
        return None
    payload = json.loads(body)
    if (not isinstance(payload, dict) or set(payload) != {'skill_id', 'version_id', 'method_id', 'scope',
            'disabled', 'expected_revision', 'operation_key'}
            or type(payload['disabled']) is not bool or type(payload['expected_revision']) is not int
            or payload['expected_revision'] < 0
            or not all(isinstance(payload[key], str) for key in ('skill_id', 'version_id', 'operation_key'))
            or not (payload['method_id'] is None or isinstance(payload['method_id'], str))):
        raise ValueError()
    from notalone.persistence.skill_policies import policy_scope
    return 'change_skill_policy', {'skill_id': UUID(payload['skill_id']), 'version_id': UUID(payload['version_id']),
        'method_id': UUID(payload['method_id']) if payload['method_id'] is not None else None,
        'scope_confirmation': policy_scope(payload['scope'], scope.contact_id), 'disabled': payload['disabled'],
        'expected_revision': payload['expected_revision'], 'operation_key': UUID(payload['operation_key'])}


def handle_skill_learning(service, *, owner_id, method, path, body):
    try:
        parts = path.strip('/').split('/')
        if len(parts) < 4 or parts[3] != 'skill-learning':
            return 404, {'error': 'not_found'}
        scope = ContactScope(owner_id, UUID(parts[2]))
        if len(parts) > 4:
            command = (_policy_command(parts, method, body, scope) if parts[4] == 'policies' else
                _history_command(parts, method, body) if parts[4] == 'skills' else _draft_command(parts, method, body, scope))
            if command is None:
                return 404, {'error': 'not_found'}
        elif method == 'POST':
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise ValueError()
            if set(payload) == {'resume'} and payload['resume'] is True:
                command = ('resume', {})
            elif (set(payload) == {'enabled', 'confirmed', 'operation_key', 'expected_revision'}
                  and type(payload['enabled']) is bool and payload['confirmed'] is True
                  and isinstance(payload['operation_key'], str)
                  and type(payload['expected_revision']) is int and payload['expected_revision'] >= 0):
                command = ('configure', {'enabled': payload['enabled'], 'operation_key': UUID(payload['operation_key']),
                                         'expected_revision': payload['expected_revision']})
            else:
                raise ValueError()
        elif method != 'GET':
            return 405, {'error': 'method_not_allowed'}
    except (ValueError, TypeError):
        return 400, {'error': 'skill_learning_request_invalid'}
    if service is None:
        return 503, {'error': 'skill_learning_unavailable'}
    try:
        if method == 'GET' and len(parts) == 4:
            return 200, service.list(scope)
        return 200, getattr(service, command[0])(scope, **command[1])
    except SkillLearningNotFound:
        return 404, {'error': 'not_found'}
    except (SkillLearningInvalid, SkillLearningUnavailable):
        return 409, {'error': 'skill_learning_stale_or_disabled'}
    except psycopg.Error:
        return 503, {'error': 'skill_learning_unavailable'}
    except (SyncHostStopped, ModelWorkStopped):
        return 503, {'error': 'runtime_stopping'}
    except Exception:
        return 500, {'error': 'internal_error'}

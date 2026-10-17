"""旧资料升级的明确用户操作入口；只接受固定动作与显式预算。"""

import json
from urllib.parse import parse_qs
from uuid import UUID

import psycopg

from notalone.application.model_priority import ModelWorkStopped
from notalone.memory.upgrade import UpgradeScope, UpgradeBudget, UpgradeConflict, UpgradeNotFound, UpgradeDeleted
from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.versions import MemoryVersionConflict
from notalone.server.sync_host import SyncHostStopped


def handle_memory_upgrade(service, *, owner_id, method, path, query, body):
    try:
        parts = path.strip('/').split('/')
        if parts[:2] != ['api', 'memory-upgrades'] or len(parts) not in (2, 3):
            return 404, {'error': 'not_found'}
        job_id = UUID(parts[2]) if len(parts) == 3 else None
        if method == 'GET':
            selected = _query_scope(owner_id, query)
        elif method not in ('POST', 'DELETE'):
            return 405, {'error': 'method_not_allowed'}
        if method != 'GET':
            payload = json.loads(body)
            if not isinstance(payload, dict) or payload.get('confirmed') is not True:
                raise ValueError()
            if job_id is None and method == 'POST':
                if set(payload) != {'scope', 'budget', 'confirmed', 'operation_key'} or query:
                    raise ValueError()
                selected = _scope(owner_id, payload['scope'])
                budget = payload['budget']
                if not isinstance(budget, dict) or set(budget) != {'message_limit', 'batch_size', 'model_calls'}:
                    raise ValueError()
                budget = UpgradeBudget(**budget)
            else:
                if job_id is None:
                    return 405, {'error': 'method_not_allowed'}
                selected = _query_scope(owner_id, query)
                action = payload.get('action')
                fields = {'action', 'expected_revision', 'operation_key', 'confirmed'}
                if action in ('apply', 'undo'):
                    fields.add('batches')
                if (set(payload) != fields or action not in ('apply', 'undo', 'cancel', 'resume', 'delete')
                        or (method == 'DELETE') != (action == 'delete')
                        or type(payload['expected_revision']) is not int or payload['expected_revision'] < 1):
                    raise ValueError()
                batches = _batches(payload.get('batches', []))
                if action in ('apply', 'undo') and not batches:
                    raise ValueError()
            operation = _identity(payload['operation_key'])
    except (ValueError, TypeError, KeyError, UnicodeDecodeError):
        return 400, {'error': 'memory_upgrade_request_invalid'}
    if service is None:
        return 503, {'error': 'memory_upgrade_unavailable'}
    try:
        if method == 'GET':
            return 200, service.read(selected, job_id) if job_id else service.list(selected)
        if job_id is None:
            return 202, service.prepare(selected, budget, operation)
        return 200, service.operate(selected, job_id, action=action,
            expected_revision=payload['expected_revision'], operation_key=operation, batches=batches)
    except UpgradeNotFound:
        return 404, {'error': 'not_found'}
    except UpgradeDeleted:
        return 410, {'error': 'memory_upgrade_deleted'}
    except (UpgradeConflict, MemoryCorrectionConflictError, MemoryVersionConflict):
        return 409, {'error': 'memory_upgrade_stale_or_unavailable'}
    except psycopg.Error:
        return 503, {'error': 'memory_upgrade_unavailable'}
    except (SyncHostStopped, ModelWorkStopped):
        return 503, {'error': 'runtime_stopping'}
    except Exception:
        return 500, {'error': 'internal_error'}


def _identity(value):
    if not isinstance(value, str):
        raise ValueError()
    return UUID(value)


def _scope(owner_id, value):
    if not isinstance(value, dict):
        raise ValueError()
    if value == {'kind': 'owner'}:
        return UpgradeScope(owner_id, 'owner')
    if set(value) != {'kind', 'contact_id'} or value['kind'] != 'contact':
        raise ValueError()
    return UpgradeScope(owner_id, 'contact', _identity(value['contact_id']))


def _query_scope(owner_id, query):
    values = parse_qs(query, keep_blank_values=True)
    if values == {'scope': ['owner']}:
        return UpgradeScope(owner_id, 'owner')
    if set(values) != {'contact_id'} or len(values['contact_id']) != 1:
        raise ValueError()
    return UpgradeScope(owner_id, 'contact', UUID(values['contact_id'][0]))


def _batches(value):
    if not isinstance(value, list) or len(value) > 200:
        raise ValueError()
    result = []
    for item in value:
        if (not isinstance(item, dict) or set(item) != {'batch_id', 'expected_revision'}
                or type(item['expected_revision']) is not int or item['expected_revision'] < 1):
            raise ValueError()
        result.append((_identity(item['batch_id']), item['expected_revision']))
    if len({identifier for identifier, revision in result}) != len(result):
        raise ValueError()
    return tuple(result)

"""所有阶段共用一次持久HTTP额度；在实际transport发送前扣费，不隐式重试。"""

from contextlib import contextmanager
from contextvars import ContextVar
import json
import time
import httpx

_CURRENT_REQUEST = ContextVar('organization_quality_request', default=None)
_CURRENT_ORGANIZATION = ContextVar('organization_runtime_request', default=None)


@contextmanager
def evaluation_request_context(store, owner_id, run_id, case, phase, deadline, budget, *, suite_budget=None, source_ref=None):
    token = _CURRENT_REQUEST.set((store, owner_id, run_id, case, phase, deadline, budget, suite_budget, source_ref))
    try:
        yield
    finally:
        _CURRENT_REQUEST.reset(token)


@contextmanager
def organization_request_context(guard, response_guard, deadline, budget, *, reserve=None):
    token = _CURRENT_ORGANIZATION.set((guard, response_guard, deadline, budget, reserve))
    try:
        yield
    finally:
        _CURRENT_ORGANIZATION.reset(token)


class OrganizationRequestBudgetExceeded(ValueError):
    pass


def response_measurements(result, payload):
    entity = result.content
    try:
        characters = len(entity.decode('utf-8'))
    except UnicodeError:
        characters = None
    choices = payload.get('choices') if isinstance(payload, dict) else None
    messages = [item.get('message') if isinstance(item, dict) else None for item in choices] if isinstance(choices, list) else []
    contents = [item.get('content') if isinstance(item, dict) else None for item in messages]
    return {'response_entity_bytes': len(entity), 'response_entity_characters': characters,
        'generated_content_characters': sum(len(value) for value in contents) if contents and all(isinstance(value, str) for value in contents) else None,
        'response_measurement': 'decoded_http_entity_utf8'}


def sanitized_request_route(url):
    from urllib.parse import urlsplit, urlunsplit
    parsed = urlsplit(str(url))
    return urlunsplit((parsed.scheme, parsed.netloc.rsplit('@', 1)[-1], parsed.path, '', ''))


class OrganizationQualityHTTPTransport(httpx.BaseTransport):
    def __init__(self, inner=None):
        self._inner = inner or httpx.HTTPTransport(retries=0)
        self.actual_network = inner is None

    def handle_request(self, request):
        context = _CURRENT_REQUEST.get()
        if context is None:
            return self._ordinary_request(request)
        store, owner_id, run_id, case, phase, deadline, budget, suite_budget, source_ref = context
        deadline.check()
        body = request.read()
        payload = json.loads(body)
        measurement = {'request_entity_bytes': len(body), 'request_entity_characters': len(body.decode('utf-8')),
            'request_measurement': 'http_entity_utf8', 'response_entity_bytes': None, 'response_entity_characters': None,
            'generated_content_characters': None, 'response_measurement': 'decoded_http_entity_utf8'}
        if measurement['request_entity_characters'] > budget.max_characters:
            store.record_budget_rejection(owner_id, case['id'], case['execution_token'], phase,
                {**measurement, 'limit_characters': budget.max_characters, 'http_attempt_reserved': False})
            raise OrganizationRequestBudgetExceeded('完整实际模型请求超过整理预算。')
        request.extensions['timeout'] = {key: deadline.remaining_seconds() for key in ('connect', 'read', 'write', 'pool')}
        route = sanitized_request_route(request.url)
        global_id = (suite_budget.reserve(source_ref=source_ref, owner_id=owner_id, run_id=run_id,
            case_id=case['id'], phase=phase) if suite_budget is not None else None)
        identifier = None
        started = time.monotonic()
        response, outcome = None, 'unknown'
        try:
            identifier = store.reserve_attempt(owner_id, run_id, case['id'], case['execution_token'], phase, payload, request_route=route, measurements=measurement)
            result = self._inner.handle_request(request)
            result.read()
            try:
                response = result.json()
            except ValueError:
                response = None
            measurement.update(response_measurements(result, response))
            outcome = 'succeeded' if result.is_success and isinstance(response, dict) else 'failed'
            deadline.check()
            return result
        finally:
            duration = max(0, int((time.monotonic() - started) * 1000))
            if identifier is not None:
                store.finish_attempt(owner_id, identifier, response=response, outcome=outcome, duration_ms=duration, measurements=measurement)
            if global_id is not None:
                suite_budget.finish(global_id, outcome=outcome, request_model=payload.get('model'),
                    response_model=response.get('model') if isinstance(response, dict) else None,
                    system_fingerprint=response.get('system_fingerprint') if isinstance(response, dict) else None,
                    duration_ms=duration, request_route=route)

    def _ordinary_request(self, request):
        context = _CURRENT_ORGANIZATION.get()
        if context is None:
            raise PermissionError('模型请求必须属于有界评测或已获实际资格的整理工作。')
        guard, response_guard, deadline, budget, reserve = context
        deadline.check()
        guard()
        payload = json.loads(request.read())
        if len(request.content.decode()) > budget.max_characters:
            raise ValueError('完整实际整理请求超过有版本预算。')
        request.extensions['timeout'] = {key: deadline.remaining_seconds() for key in ('connect', 'read', 'write', 'pool')}
        from notalone.problem_budget import reserve_problem_attempt
        reserve_problem_attempt(request=request)
        if reserve is not None:
            reserve()
        result = self._inner.handle_request(request)
        result.read()
        deadline.check()
        guard()
        if result.is_success:
            response_guard(payload, result.json(), sanitized_request_route(request.url))
        return result

    def close(self):
        self._inner.close()

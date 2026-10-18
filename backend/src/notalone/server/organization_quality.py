"""质量评测的已认证管理HTTP；客户端不能直接授予verified状态。"""

import json
from http import HTTPStatus
from uuid import UUID
from notalone.memory.layered import LayeredMemoryConflict


def handle_quality(service, owner_id, method, path, body):
    from notalone.server.app import _json_response
    try:
        parts = path.strip('/').split('/')
        if (len(parts) == 4 and parts[:2] == ['api', 'layered-memory']
                and parts[2] in {'quality-inputs', 'quality-runs'} and method == 'DELETE'):
            return _json_response(HTTPStatus.OK, service._quality._store.withdraw(owner_id, UUID(parts[3]), run=parts[2] == 'quality-runs'))
        if len(parts) == 4 and parts[:3] == ['api', 'layered-memory', 'quality-inputs'] and method == 'GET':
            return _json_response(HTTPStatus.OK, {'quality_input': service._quality._store.read_case(owner_id, UUID(parts[3]))})
        if (len(parts) == 5 and parts[:3] == ['api', 'layered-memory', 'quality-inputs']
                and parts[4] in {'annotations', 'review'} and method == 'POST'):
            result = service._quality._store.review_case(owner_id, UUID(parts[3]), json.loads(body), output=parts[4] == 'review')
            return _json_response(HTTPStatus.OK, {'quality_input': result})
        if parts[:3] == ['api', 'layered-memory', 'quality-runs']:
            if len(parts) == 3 and method == 'POST':
                return _json_response(HTTPStatus.OK, {'quality_report': service._quality.create_run(owner_id, json.loads(body))})
            if len(parts) == 5 and method == 'POST' and parts[4] in {'execute', 'calibration'}:
                if parts[4] == 'execute':
                    result = service._quality.execute(owner_id, UUID(parts[3]), json.loads(body))
                else:
                    service._quality._store.calibrate(owner_id, UUID(parts[3]), json.loads(body), service._quality.organization_contract)
                    result = service._quality.report(owner_id, UUID(parts[3]))
                return _json_response(HTTPStatus.OK, {'quality_report': result})
            if len(parts) == 4 and method == 'GET':
                return _json_response(HTTPStatus.OK, {'quality_report': service._quality.report(owner_id, UUID(parts[3]))})
        return _json_response(HTTPStatus.NOT_FOUND, {'error': 'not_found'})
    except (ValueError, TypeError, KeyError, UnicodeError):
        return _json_response(HTTPStatus.BAD_REQUEST, {'error': 'quality_request_invalid'})
    except LayeredMemoryConflict:
        return _json_response(HTTPStatus.CONFLICT, {'error': 'quality_input_changed'})
    except (LookupError, PermissionError):
        return _json_response(HTTPStatus.NOT_FOUND, {'error': 'quality_evidence_not_found'})

    except RuntimeError:
        return _json_response(HTTPStatus.SERVICE_UNAVAILABLE, {'error': 'quality_evaluation_unavailable'})

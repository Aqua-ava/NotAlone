"""表达样本具名 HTTP 操作；owner由认证宿主提供。"""

from __future__ import annotations

import json
from uuid import UUID

from notalone.application.style_sample_service import (
    SaveStyleSample, StyleSample, StyleSampleConflict, StyleSampleDeleted,
    StyleSampleError, StyleSampleNotFound, StyleSampleService,
)
from notalone.scopes import ContactScope


def sample_payload(sample: StyleSample) -> dict[str, object]:
    return {"sample_id": str(sample.sample_id), "text": sample.text,
            "origin_kind": sample.origin_kind,
            "origin_id": None if sample.origin_id is None else str(sample.origin_id),
            "source_ids": [str(value) for value in sample.source_ids],
            "saved_at": sample.saved_at.isoformat(), "sending_status": sample.sending_status}


def handle_style_samples(service: StyleSampleService, *, owner_id: UUID, method: str,
                         path: str, body: bytes) -> tuple[int, dict[str, object]]:
    parts = path.strip("/").split("/")
    try:
        if len(parts) not in (4, 5) or parts[:2] != ["api", "contacts"] or parts[3] != "style-samples":
            return 404, {"error": "not_found"}
        scope = ContactScope(owner_id, UUID(parts[2]))
        if len(parts) == 4 and method == "GET":
            return 200, {"samples": [sample_payload(sample) for sample in service.list(scope)]}
        if len(parts) == 4 and method == "POST":
            payload = json.loads(body)
            if not isinstance(payload, dict) or set(payload) != {"idempotency_key", "text", "origin"}:
                raise ValueError
            origin = payload["origin"]
            if not isinstance(origin, dict) or set(origin) != ({"kind"} if origin.get("kind") == "manual" else {"kind", "id"}):
                raise ValueError
            command = SaveStyleSample(UUID(payload["idempotency_key"]), payload["text"],
                                      origin["kind"], None if "id" not in origin else UUID(origin["id"]))
            return 200, {"sample": sample_payload(service.save(scope, command))}
        if len(parts) == 5 and method == "GET":
            return 200, {"sample": sample_payload(service.read(scope, UUID(parts[4])))}
        if len(parts) == 5 and method == "DELETE":
            service.delete(scope, UUID(parts[4]))
            return 200, {"state": "deleted"}
        return 405, {"error": "method_not_allowed"}
    except (ValueError, TypeError, KeyError, AttributeError):
        return 400, {"error": "style_sample_invalid"}
    except StyleSampleNotFound:
        return 404, {"error": "style_sample_not_found"}
    except StyleSampleDeleted:
        return 410, {"error": "style_sample_deleted"}
    except StyleSampleConflict:
        return 409, {"error": "style_sample_conflict"}
    except StyleSampleError:
        return 503, {"error": "style_sample_unavailable"}

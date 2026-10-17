"""明确保存长期表达要求的认证HTTP管理入口。"""

from __future__ import annotations

import json
from uuid import UUID
from urllib.parse import parse_qs

from notalone.application.expression_preference_service import (
    ExpressionPreference, ExpressionPreferenceConflict, ExpressionPreferenceDeleted,
    ExpressionPreferenceError, ExpressionPreferenceNotFound, ExpressionPreferenceScope,
    ExpressionPreferenceService, SaveExpressionPreference,
    UpdateExpressionPreference, DeleteExpressionPreference,
)


def preference_payload(preference: ExpressionPreference) -> dict[str, object]:
    origin: dict[str, object] = {"kind": preference.origin_kind}
    if preference.origin_id is not None:
        origin["id"] = str(preference.origin_id)
    return {
        "preference_id": str(preference.preference_id), "text": preference.text,
        "scope": {"contact_id": None if preference.scope.contact_id is None else str(preference.scope.contact_id),
                  "reply_mode": preference.scope.reply_mode},
        "revision": preference.revision,
        "confirmed_operation_key": str(preference.confirmed_operation_key),
        "origin": origin, "source_ids": [str(value) for value in preference.source_ids],
        "confirmed_at": preference.confirmed_at.isoformat(), "updated_at": preference.updated_at.isoformat(),
    }


def handle_expression_preferences(service: ExpressionPreferenceService, *, owner_id: UUID,
                                  method: str, path: str, body: bytes, query: str = "") -> tuple[int, dict[str, object]]:
    parts = path.strip("/").split("/")
    try:
        if parts[:2] != ["api", "expression-preferences"] or len(parts) not in {2, 3}:
            return 404, {"error": "not_found"}
        selection = parse_qs(query, keep_blank_values=True)
        if set(selection) - {"contact_id"} or any(len(values) != 1 for values in selection.values()):
            raise ValueError
        contact_id = None if not selection else UUID(selection["contact_id"][0])
        if method == "GET":
            if len(parts) == 2:
                return 200, {"preferences": [preference_payload(item) for item in service.list(owner_id, contact_id=contact_id)]}
            return 200, {"preference": preference_payload(service.read(owner_id, UUID(parts[2]), contact_id=contact_id))}
        if method == "PATCH" and len(parts) == 3:
            payload = json.loads(body)
            if not isinstance(payload, dict) or set(payload) != {
                "operation_key", "expected_revision", "text", "scope", "confirm_long_term",
            } or payload["confirm_long_term"] is not True:
                raise ValueError
            scope_value = payload["scope"]
            if not isinstance(scope_value, dict) or set(scope_value) != {"contact_id", "reply_mode"}:
                raise ValueError
            scope = ExpressionPreferenceScope(
                owner_id, None if scope_value["contact_id"] is None else UUID(scope_value["contact_id"]),
                scope_value["reply_mode"],
            )
            command = UpdateExpressionPreference(UUID(payload["operation_key"]), payload["expected_revision"], payload["text"], scope)
            return 200, {"preference": preference_payload(service.update(UUID(parts[2]), command, contact_id=contact_id))}
        if method == "DELETE" and len(parts) == 3:
            payload = json.loads(body)
            if not isinstance(payload, dict) or set(payload) != {"operation_key", "expected_revision"}:
                raise ValueError
            service.delete(owner_id, UUID(parts[2]), DeleteExpressionPreference(UUID(payload["operation_key"]), payload["expected_revision"]), contact_id=contact_id)
            return 200, {"state": "deleted"}
        if method == "POST" and len(parts) == 2:
            payload = json.loads(body)
            if not isinstance(payload, dict) or set(payload) != {
                "operation_key", "text", "scope", "origin", "confirm_long_term",
            } or payload["confirm_long_term"] is not True:
                raise ValueError
            scope_value, origin = payload["scope"], payload["origin"]
            if not isinstance(scope_value, dict) or set(scope_value) != {"contact_id", "reply_mode"}:
                raise ValueError
            if not isinstance(origin, dict) or set(origin) != (
                {"kind"} if origin.get("kind") == "manual" else {"kind", "id"}
            ):
                raise ValueError
            scope = ExpressionPreferenceScope(
                owner_id, None if scope_value["contact_id"] is None else UUID(scope_value["contact_id"]),
                scope_value["reply_mode"],
            )
            command = SaveExpressionPreference(
                UUID(payload["operation_key"]), payload["text"], scope,
                origin["kind"], None if "id" not in origin else UUID(origin["id"]),
            )
            if contact_id is not None and command.scope.contact_id not in {None, contact_id}:
                raise ValueError
            return 200, {"preference": preference_payload(service.save(command, contact_id=contact_id))}
        return 405, {"error": "method_not_allowed"}
    except (ValueError, TypeError, KeyError, AttributeError):
        return 400, {"error": "expression_preference_invalid"}
    except ExpressionPreferenceNotFound:
        return 404, {"error": "expression_preference_not_found"}
    except ExpressionPreferenceDeleted:
        return 410, {"error": "expression_preference_deleted"}
    except ExpressionPreferenceConflict:
        return 409, {"error": "expression_preference_conflict"}
    except ExpressionPreferenceError:
        return 503, {"error": "expression_preference_unavailable"}

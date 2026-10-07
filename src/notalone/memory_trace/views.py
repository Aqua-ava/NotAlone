"""只从实际保存的事件形成查询视图；缺少后续记录时明确保留缺口。"""

from __future__ import annotations

from typing import Any


def candidate_summaries(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates: dict[str, dict[str, Any]] = {}
    for event in events:
        payload = event["payload"]
        if event["stage"] == "extraction_return":
            for index, identifier in enumerate(
                payload.get("candidate_trace_ids", ())
            ):
                candidates[str(identifier)] = {
                    "candidate_trace_id": str(identifier),
                    "index": index,
                    "disposition": "not_recorded",
                    "stages": [],
                }
        identifier = event.get("candidate_trace_id")
        if identifier is None:
            continue
        identifier = str(identifier)
        item = candidates.setdefault(
            identifier,
            {
                "candidate_trace_id": identifier,
                "index": None,
                "disposition": "not_recorded",
                "stages": [],
            },
        )
        item["stages"].append(event["stage"])
        if event["stage"] == "candidate_raw":
            item.update(index=payload["index"], raw_fields=payload["fields"])
        disposition = payload.get("disposition")
        if disposition not in (None, "continue"):
            item["disposition"] = disposition
        if (
            event["stage"] == "write_plan"
            and item["disposition"] == "not_recorded"
        ):
            item["disposition"] = "write_outcome_not_recorded"
        if "not_executed" in payload:
            item["not_executed"] = payload["not_executed"]
    return list(candidates.values())

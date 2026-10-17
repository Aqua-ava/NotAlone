"""六种有限产生式的独立规范图；不读Gold，不使用模型身份答案。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
import re
from typing import Any

from notalone.memory.bounded_evidence import (
    GRAMMARS, ROLE_KINDS, ROLE_SLOTS, RELATION_TOKENS as _RELATIONS,
    OBJECT_TOKENS as _OBJECTS, DESTINATION_TOKENS as _DESTINATIONS, TIME_TOKENS as _TIMES,
)
from .models import MessageRef, ExtractionWindow, ExtractedFact


@dataclass(frozen=True)
class Part:
    message: MessageRef
    text: str
    start: int
    order: tuple[int, int]
    sender: str


@dataclass
class Graph:
    rule: str
    variant: str
    frame: str
    roles: list[dict]
    atoms: list[dict]
    qualifiers: list[dict]
    bindings: list[dict]
    event: Part

    def semantic(self) -> dict:
        return {"roles": [{key: value for key, value in row.items() if key != "span"} for row in self.roles],
            "atoms": [{key: value for key, value in row.items() if key != "span"} for row in self.atoms],
            "qualifiers": [{key: value for key, value in row.items() if key != "span"} for row in self.qualifiers], "frame": self.frame}


def source_parts(window: ExtractionWindow) -> list[Part]:
    parts = []
    for index, message in enumerate(window.messages):
        body = message.text.strip(" ")
        offset = len(message.text) - len(message.text.lstrip(" "))
        if not body:
            parts.append(Part(message, "", offset, (index, offset), message.sender.value))
        for match in re.finditer(r"[^。]+。?|。", body):
            parts.append(Part(message, match.group(), offset + match.start(), (index, offset + match.start()), message.sender.value))
    return parts


def candidate_parts(window: ExtractionWindow, fact: ExtractedFact, rep) -> list[Part]:
    positions = {message.message_id: index for index, message in enumerate(window.messages)}

    def quoted_part(message: MessageRef, text: str, start: int, source_start: int, source_end: int, sender: str) -> Part:
        # 仅实际原消息边界允许U+0020；不能把句间空白当作新引句边界。
        left = len(text) - len(text.lstrip(" ")) if not message.text[:source_start].strip(" ") else 0
        right = len(text.rstrip(" ")) if not message.text[source_end:].strip(" ") else len(text)
        return Part(message, text[left:right], start + left, (positions[message.message_id], source_start), sender)

    party = "self" if rep.author == "用户" else "contact"
    parts = [quoted_part(rep.target, fact.text[rep.quote_start:rep.quote_end], rep.quote_start,
                         rep.main[0].start, rep.main[-1].end, party)]
    for unit, start, end in rep.contexts:
        author = "用户" if fact.text.startswith("用户说“", start) else "联系人"
        quote_start = start + len(author + "说“")
        parts.append(quoted_part(unit.message, fact.text[quote_start:end - 1], quote_start,
                                 unit.start, unit.end, "self" if author == "用户" else "contact"))
    return parts


def parse(parts: list[Part], frame: str, *, source: bool) -> Graph | None:
    """同一有限解析器分别处理两棵实际文本树；不把来源图复制给候选。"""
    events: list[tuple[Part, re.Match[str], str]] = []
    identities: list[tuple[Part, re.Match[str], str]] = []
    catalogs: list[tuple[Part, re.Match[str], str]] = []
    questions: list[tuple[Part, re.Match[str], str]] = []
    for part in parts:
        body = part.text
        found = False
        for kind in ("roles", "identity", "arrival", "lend", "request", "plan", "question", "answer"):
            match = re.fullmatch(GRAMMARS[kind], body)
            if match is None:
                continue
            parsed_row = (part, match, kind)
            (catalogs if kind == "roles" else identities if kind == "identity" else questions if kind == "question" else events).append(parsed_row)
            found = True
            break
        if not found:
            return None
    if len(events) != 1 or len(identities) > 1 or len(catalogs) > 1 or len(questions) > 1:
        return None
    event, match, kind = events[0]
    identity = identities[0] if identities else None
    catalog = catalogs[0] if catalogs else None
    question = questions[0] if questions else None
    if kind in {"arrival", "plan"} and (identities or catalogs or questions):
        return None
    if kind == "answer":
        if len(parts) != 2 or question is None or identity is not None or catalog is not None:
            return None
        q, qm, _ = question
        if q.sender == event.sender or q.order[0] + 1 != event.order[0] or qm["verb"] != match["verb"]:
            return None
    elif question is not None:
        return None
    if kind in {"lend", "request"}:
        if identity is None:
            return None
        i, im, _ = identity
        if i.sender != event.sender or im["pronoun"] != match["pronoun"]:
            return None
        if i.order[0] != event.order[0] and i.order[0] + 1 != event.order[0]:
            return None
        if kind == "lend" and ((match["negative"] is not None and (match["time"] is None or match["completion"] is not None))
                               or match["negative"] is None and match["completion"] != "了"):
            return None
        roles = {match["agent"], im["role"]}
        if catalog is not None:
            r, rm, _ = catalog
            if (rm["first"] == rm["second"] or r.sender != event.sender or r.order >= i.order
                    or r.order[0] == event.order[0] or not roles <= {rm["first"], rm["second"]}):
                return None
            roles.update((rm["first"], rm["second"]))
        if len(roles) > 2:
            return None
    elif identities or catalogs:
        return None
    if kind == "request" and frame not in {"reported_request", "received_request"}:
        return None
    frame = frame if kind == "request" else "direct"
    suffix = "inline" if identity is not None and identity[0].order[0] == event.order[0] else "cross"
    rule, variant = {"arrival": ("BR_AUTHOR_ARRIVAL_V1", "direct_quote"), "answer": ("BR_COMPLETED_QA_V1", "completed_answer"),
        "plan": ("BR_COND_RUN_V1", "conditional_plan"), "lend": ("BR_TWO_ROLES_V1" if catalog is not None else "BR_KIN_LEND_V1", "negative_" + suffix if match.groupdict().get("negative") else "completed_" + suffix),
        "request": ("BR_REQUEST_V1", ("reported_" if frame == "reported_request" else "received_") + suffix)}[kind]
    sender = event.sender
    author_key = (sender, "author")
    role_anchors: dict[tuple, list[tuple[Part, int, int]]] = {}

    def anchor(part: Part, start: int, end: int) -> tuple[Part, int, int]:
        return part, part.start + start, part.start + end

    def token(name: str, *, part=event, matched=match):
        start, end = matched.span(name)
        return anchor(part, start, end)

    def role(key, location):
        role_anchors.setdefault(key, []).append(location)
        return key

    author_anchor = token("author") if match.groupdict().get("author") else anchor(event, 0, len(event.text))
    role(author_key, author_anchor)
    atom_rows: list[dict[str, Any]] = []
    qualifier_rows: list[dict[str, Any]] = []
    binding_rows: list[dict[str, Any]] = []

    def atom(predicate: str, phase: str, slots: dict, location):
        identifier = len(atom_rows)
        atom_rows.append({"atom_id": identifier, "predicate": predicate, "phase": phase,
            "roles": {name: slots.get(name) for name in ROLE_SLOTS}, "span": location})
        return identifier

    def qualifier(kind: str, location, **values):
        qualifier_rows.append({"kind": kind, **values, "span": location})

    def time(atom_id: int, slot: str, name: str):
        raw = match.groupdict().get(name)
        if raw is None:
            return True
        from .source_proof import bounded_source_occurred_at
        actual = bounded_source_occurred_at(event.message)
        if event.message.occurred_at is not None and actual is None:
            return False
        interval = None
        if kind == "plan":
            if actual is None:
                return False
            start = actual.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1 if raw == "明天" else 2)
            interval = {"start": start.isoformat(), "end": (start + timedelta(days=1)).isoformat()}
        qualifier("time", token(name), atom_id=atom_id, slot=slot,
                  value={"token": _TIMES[raw], "anchor": actual.isoformat() if actual else None, "interval": interval})
        return True

    whole = anchor(event, 0, len(event.text))
    binding_rows.append({"role": author_key, "method": "actual_sender", "mention": author_anchor, "target": author_anchor, "binding": None})
    if kind in {"arrival", "answer"}:
        if kind == "arrival":
            destination_part, destination_match = event, match
        else:
            assert question is not None
            destination_part, destination_match = question[0], question[1]
        destination = role((None, _DESTINATIONS[destination_match["destination"]]), token("destination", part=destination_part, matched=destination_match))
        atom("arrive", "completed", {"actor": author_key, "destination": destination}, whole)
        if kind == "answer":
            assert question is not None
            q, qm, _ = question
            binding_rows.append({"role": destination, "method": "completed_question", "mention": token("verb"),
                "target": token("destination", part=q, matched=qm), "binding": anchor(q, 0, len(q.text))})
        elif not time(0, "event_time", "time"):
            return None
    elif kind in {"lend", "request"}:
        assert identity is not None
        i, im, _ = identity
        agent = role((sender, _RELATIONS[match["agent"]]), token("agent"))
        owner = role((sender, _RELATIONS[im["role"]]), token("role", part=i, matched=im))
        binding_rows.append({"role": owner, "method": "source_identity", "mention": token("pronoun"),
            "target": token("role", part=i, matched=im), "binding": anchor(i, 0, len(i.text))})
        if kind == "lend":
            obj = role((None, _OBJECTS[match["object"]]), token("object"))
            atom("lend", "completed", {"agent": agent, "recipient": author_key, "object": obj, "property_owner": owner}, whole)
            qualifier("polarity", token("negative") if match["negative"] else whole,
                      atom_id=0, slot="predicate", value=match["negative"] is None)
            if not time(0, "event_time", "time"):
                return None
        else:
            atom("request" if frame == "reported_request" else "receive_request", "historical", {"agent": agent, "recipient": author_key}, whole)
            end = len(event.text) - (1 if event.text.endswith("。") else 0)
            atom("cover_shift", "requested", {"actor": author_key, "beneficiary": owner}, anchor(event, match.start("author"), end))
            if not time(0, "event_time", "outer_time") or not time(1, "requested_time", "time"):
                return None
    else:
        number = Decimal(match["number"])
        if number > Decimal(100000):
            return None
        metres = format(number * (1000 if match["unit"] == "公里" else 1), "f")
        if "." in metres:
            metres = metres.rstrip("0").rstrip(".")
        comma = event.text.index("，") + 1
        atom("clear_weather", "condition", {}, anchor(event, 0, comma))
        atom("run", "planned", {"actor": author_key}, anchor(event, comma, len(event.text)))
        qualifier("quantity", anchor(event, match.start("number"), match.end("unit")), atom_id=1, slot="distance", value={"metres": metres})
        for modifier in ("only", "approx"):
            if match[modifier]:
                qualifier("degree", token(modifier), quantity_qualifier_id=0, modifier=modifier, value=modifier)
        qualifier("condition", whole, condition_atom_id=0, action_atom_id=1, relation="requires")
        if not time(1, "event_time", "time"):
            return None
    keys = sorted(role_anchors, key=lambda key: (("self", "contact", None).index(key[0]), ROLE_KINDS.index(key[1])))
    identifiers = {key: index for index, key in enumerate(keys)}
    def first(locations):
        return min(locations, key=lambda item: (item[0].order[0], item[1])) if source else min(locations, key=lambda item: item[1])
    role_rows = [{"role_id": identifiers[key], "kind": key[1], "owner": key[0], "sender": key[0] if key[1] == "author" else None,
                  "span": first(role_anchors[key])} for key in keys]
    for row in atom_rows:
        row["roles"] = {name: identifiers[value] if value is not None else None for name, value in row["roles"].items()}
    qualifier_rows.sort(key=lambda row: (("polarity", "quantity", "degree", "condition", "time").index(row["kind"]),
        row.get("atom_id", row.get("action_atom_id", 0)), row.get("slot", ""), ("only", "approx").index(row["modifier"]) if row["kind"] == "degree" else 0))
    for index, row in enumerate(qualifier_rows):
        row["qualifier_id"] = index
        if row["kind"] == "degree":
            row["quantity_qualifier_id"] = next(item["qualifier_id"] for item in qualifier_rows if item["kind"] == "quantity")
    for row in binding_rows:
        row["role_id"] = identifiers[row.pop("role")]
    binding_rows.sort(key=lambda row: (row["role_id"], ("actual_sender", "source_identity", "completed_question").index(row["method"]), row["mention"][0].order, row["mention"][1]))
    return Graph(rule, variant, frame, role_rows, atom_rows, qualifier_rows, binding_rows, event)


def assemble(source: Graph, candidate: Graph, window: ExtractionWindow, fact: ExtractedFact, rep) -> dict:
    from .bounded_proof import text_span, message_span, representation_payload
    from notalone.memory.bounded_evidence import CAPABILITIES, digest, rule_set_sha256
    def origin(location):
        part, start, end = location
        return message_span(part.message, start, end)
    def target(location):
        _, start, end = location
        return text_span(fact.text, start, end)
    def rows(name):
        result = []
        for left, right in zip(getattr(source, name), getattr(candidate, name)):
            row = {key: value for key, value in left.items() if key not in {"span", "value"}}
            if "value" in left:
                row["value_sha256"] = digest(left["value"])
            row.update(source=origin(left["span"]), candidate=target(right["span"]))
            result.append(row)
        return result
    roles = rows("roles")
    author = next(row for row in roles if row["kind"] == "author")
    author["candidate"] = text_span(fact.text, rep.author_start, rep.author_start + len(rep.author))
    return {"version": 3, "rule_set_sha256": rule_set_sha256(), "rules": [{"rule_id": source.rule, "rule_version": 1}],
        "roles": roles, "atoms": rows("atoms"), "qualifiers": rows("qualifiers"),
        "reference_bindings": [{"role_id": row["role_id"], "method": row["method"], "mention": origin(row["mention"]),
            "target": origin(row["target"]), "binding": origin(row["binding"]) if row["binding"] else None} for row in source.bindings],
        "frame": source.frame, "unresolved": [], "source_graph_sha256": digest(source.semantic()), "candidate_graph_sha256": digest(candidate.semantic()),
        "representation": representation_payload(rep, window, fact),
        "capabilities": [item for item in CAPABILITIES if item != ("reported_attribution" if source.frame == "direct" else "direct_attribution")]}

"""旧回复读取已移交概览；只接受同宿主认证响应，失败不退回本地写入。"""

from datetime import datetime
import json
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

from notalone.memory.models import (
    AdoptionMethod, ConfirmedMemory, ConfirmedMemoryStatus, MemoryCategory,
    MemoryRetirementReason, MemoryTopic, SourceDependencyMode,
)
from notalone.memory.events import MemoryEvent
from notalone.memory.conditions import MemoryConditions
from notalone.memory.evolution import MemoryEvolution
from notalone.memory.version_evidence import VersionEvidence
from notalone.memory.timing import MemoryTiming
from notalone.memory.overview import (
    OverviewEntry, OverviewMemoryIdentity, OverviewSourceReference,
    OverviewUnavailable, RelationshipOverview,
)
from notalone.scopes import ContactScope


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _time(value):
    return datetime.fromisoformat(value) if value is not None else None


def decode_contact_overview(value: dict, scope: ContactScope) -> RelationshipOverview:
    if (value['version'] != 1 or value['scope_kind'] != 'contact'
            or UUID(value['contact_id']) != scope.contact_id):
        raise ValueError('概览范围无效。')
    entries = []
    for entry in value['entries']:
        row = entry['memory']
        if row['level'] != 'contact' or UUID(row['contact_id']) != scope.contact_id:
            raise ValueError('关系资料范围无效。')
        version = VersionEvidence.from_payload(row['version_evidence'])
        if version is not None:
            version = version.with_current_sources(row['version_evidence_source_current'])
        memory = ConfirmedMemory(
            memory_id=UUID(row['memory_id']), scope=scope, text=row['text'],
            category=MemoryCategory(row['category']), topic=MemoryTopic(row['topic']),
            source_ids=tuple(UUID(identifier) for identifier in row['source_ids']),
            source_candidate_id=UUID(row['source_candidate_id']) if row['source_candidate_id'] else None,
            adoption_method=AdoptionMethod(row['adoption_method']), status=ConfirmedMemoryStatus(row['status']),
            revision=row['revision'], confidence=row['confidence'], risk_flags=tuple(row['risk_flags']),
            retirement_reason=MemoryRetirementReason(row['retirement_reason']), retired_at=_time(row['retired_at']),
            supersedes_memory_id=UUID(row['supersedes_memory_id']) if row['supersedes_memory_id'] else None,
            valid_at=_time(row['valid_at']), invalid_at=_time(row['invalid_at']), timing=MemoryTiming.from_payload(row['timing']),
            event=MemoryEvent.from_payload(row['event']), conditions=MemoryConditions.from_payload(row['conditions']),
            evolution=MemoryEvolution.from_payload(row['evolution']), version_evidence=version,
            can_revert_auto_update=row['can_revert_auto_update'],
            source_dependency_mode=SourceDependencyMode(row.get('source_dependency_mode', 'any')),
        )
        leaf = entry['current_leaf']
        references = tuple(OverviewSourceReference(
            source_id=UUID(ref['source_id']), source_kind=ref['source_kind'],
            message_id=UUID(ref['message_id']) if ref['message_id'] else None,
            source_ref_id=UUID(ref['source_ref_id']) if ref['source_ref_id'] else None,
            locator=ref['locator'],
        ) for ref in entry['provenance']['references'])
        entries.append(OverviewEntry(
            memory, OverviewMemoryIdentity(UUID(leaf['memory_id']), leaf['revision']) if leaf else None,
            entry['provenance']['kind'], references,
            tuple(UUID(identifier) for identifier in entry['dependency_ids']),
        ))
    return RelationshipOverview(scope, value['projection_revision'], value['memory_revision'],
                                datetime.fromisoformat(value['built_at']), tuple(entries))


def read_transferred_overview(target: tuple[str, str], scope: ContactScope) -> RelationshipOverview:
    address, token = target
    request = Request(f'http://{address}/api/contacts/{scope.contact_id}/relationship-overview',
                      headers={'Authorization': f'Bearer {token}', 'X-NotAlone-Owner-ID': str(scope.owner_id)})
    try:
        with build_opener(ProxyHandler({}), _NoRedirect()).open(request, timeout=10) as response:
            if response.status != 200:
                raise ValueError('概览未就绪。')
            body = response.read(16 * 1024 * 1024 + 1)
            if len(body) > 16 * 1024 * 1024:
                raise ValueError('概览响应超限。')
        return decode_contact_overview(json.loads(body)['overview'], scope)
    except Exception:
        raise OverviewUnavailable('已移交概览暂不可用。') from None

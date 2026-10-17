"""一位已确认联系人的可追溯概览入口。"""

from uuid import UUID

from notalone.memory.overview import RelationshipOverview, RelationshipOverviewPort
from notalone.scopes import ContactScope


class RelationshipOverviewService:
    def __init__(self, store: RelationshipOverviewPort) -> None:
        self._store = store

    def read(self, *, owner_id: UUID, contact_id: UUID) -> RelationshipOverview:
        return self._store.read_contact(ContactScope(owner_id, contact_id))

    def read_owner(self, *, owner_id: UUID) -> RelationshipOverview:
        return self._store.read_owner(owner_id)

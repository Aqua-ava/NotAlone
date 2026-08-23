"""NotAlone 持久化适配层。"""

from notalone.persistence.conversation_repository import (
    ConversationBindingConflictError,
    ConversationBindingNotFoundError,
    ConversationBindingPersistenceError,
    PersistedConversationBinding,
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)
from notalone.persistence.memory_store import (
    MemoryInvariantError,
    MemoryPersistenceError,
    PostgresMemoryStore,
)
from notalone.persistence.owner_memory_store import (
    OwnerMemoryPersistenceError,
    PostgresOwnerMemoryStore,
)
from notalone.persistence.watermark_store import (
    PostgresWatermarkStore,
    WatermarkPersistenceError,
)
from notalone.persistence.outbound_ledger import (
    OutboundLedgerPersistenceError,
    PostgresOutboundLedger,
)
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.persistence.retrieval import PostgresRetrieval
from notalone.persistence.skill_port import (
    PostgresSkillPort,
    SkillPortPersistenceError,
)

__all__ = [
    "ConversationBindingConflictError",
    "ConversationBindingNotFoundError",
    "ConversationBindingPersistenceError",
    "MemoryInvariantError",
    "MemoryPersistenceError",
    "OutboundLedgerPersistenceError",
    "OwnerMemoryPersistenceError",
    "PersistedConversationBinding",
    "PostgresConversationBindingRepository",
    "PostgresConversationPort",
    "PostgresMemoryStore",
    "PostgresOutboundLedger",
    "PostgresOwnerMemoryStore",
    "PostgresReplyStore",
    "PostgresRetrieval",
    "PostgresSkillPort",
    "PostgresWatermarkStore",
    "SkillPortPersistenceError",
    "WatermarkPersistenceError",
]

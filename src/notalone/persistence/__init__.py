"""NotAlone 持久化适配层。"""

from notalone.persistence.conversation_repository import (
    ConversationBindingConflictError,
    ConversationBindingNotFoundError,
    ConversationBindingPersistenceError,
    PersistedConversationBinding,
    PostgresConversationBindingRepository,
    PostgresConversationPort,
)
from notalone.persistence.contact_memory_index import (
    ContactMemoryIndex,
    ContactMemoryIndexBuilder,
    ContactMemoryIndexBuildError,
    ContactMemoryIndexError,
    ContactMemoryIndexPersistenceError,
    ContactMemoryIndexStatus,
    ContactMemoryIndexTopic,
    ContactMemoryIndexValidationError,
    IndexBuildResult,
    IndexVerificationResult,
    PostgresContactMemoryIndexRepository,
)
from notalone.persistence.background_tasks import (
    BackgroundTaskLeaseError,
    BackgroundTaskNotFoundError,
    BackgroundTaskPersistenceError,
    BackgroundTaskStateError,
    PostgresBackgroundTaskRepository,
)
from notalone.persistence.memory_store import (
    MemoryInvariantError,
    MemoryPersistenceError,
    PostgresMemoryStore,
)
from notalone.persistence.observation_store import (
    ObservationCursor,
    ObservationMode,
    ObservationNotFoundError,
    ObservationPersistenceError,
    ObservationWatermarkError,
    PersistedObservation,
    PostgresObservationStore,
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
    "ContactMemoryIndex",
    "ContactMemoryIndexBuilder",
    "ContactMemoryIndexBuildError",
    "ContactMemoryIndexError",
    "ContactMemoryIndexPersistenceError",
    "ContactMemoryIndexStatus",
    "ContactMemoryIndexTopic",
    "ContactMemoryIndexValidationError",
    "BackgroundTaskLeaseError",
    "BackgroundTaskNotFoundError",
    "BackgroundTaskPersistenceError",
    "BackgroundTaskStateError",
    "MemoryInvariantError",
    "MemoryPersistenceError",
    "ObservationCursor",
    "ObservationMode",
    "ObservationNotFoundError",
    "ObservationPersistenceError",
    "ObservationWatermarkError",
    "OutboundLedgerPersistenceError",
    "OwnerMemoryPersistenceError",
    "PersistedConversationBinding",
    "PersistedObservation",
    "PostgresConversationBindingRepository",
    "PostgresConversationPort",
    "PostgresContactMemoryIndexRepository",
    "PostgresBackgroundTaskRepository",
    "PostgresMemoryStore",
    "PostgresObservationStore",
    "PostgresOutboundLedger",
    "PostgresOwnerMemoryStore",
    "PostgresReplyStore",
    "PostgresRetrieval",
    "PostgresSkillPort",
    "PostgresWatermarkStore",
    "IndexBuildResult",
    "IndexVerificationResult",
    "SkillPortPersistenceError",
    "WatermarkPersistenceError",
]

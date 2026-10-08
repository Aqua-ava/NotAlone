"""CLI 观察来源遵循与历史导入相同的回复删除契约。"""

from notalone.ingest.models import NormalizedMessage, WechatMessageMetadata
from notalone.persistence.observation_store import (
    ObservationMode,
    ObservationPersistenceError,
)
from notalone.persistence.reply_store import PostgresReplyStore
from notalone.scopes import ContactScope
from tests.integration.persistence import reply_deletion_contract as contract
from tests.integration.persistence import test_observation_store as observations


class ObservationReplyDeletionTest(contract.ReplyDeletionContract):
    deletion_error = ObservationPersistenceError

    @classmethod
    def setUpClass(cls) -> None:
        observations.PostgresObservationStoreTest.setUpClass()

    def setUp(self) -> None:
        self.observations = observations.PostgresObservationStoreTest()
        self.observations.setUp()
        self.addCleanup(self.observations.tearDown)
        self.scope = ContactScope(
            self.observations.owner_id, self.observations.contact_a
        )
        self.binding_id = self.observations.binding_a.binding_id
        self.message_text = "观察来源的合成消息"
        batch = self.observations.store.record_batch_with_messages(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            binding_id=self.binding_id,
            mode=ObservationMode.LIVE,
            cli_version="synthetic-test",
            conversation_locator="wxid_observation_a",
            last_local_id=10,
            last_cursor="cursor-10",
            record_count=1,
            messages=(NormalizedMessage(
                source_locator="cli:10",
                speaker="contact",
                message_type="text",
                text_content=self.message_text,
                media_placeholder=None,
                occurred_at=None,
                wechat_metadata=WechatMessageMetadata(
                    external_local_id=10,
                    external_server_id="synthetic-10",
                    external_talker="wxid_observation_a",
                    source_create_time=100,
                    raw_payload_json='{"text":"观察来源的合成消息"}',
                ),
            ),),
        )
        self.source_id = batch.observation.observation_id
        self.message_id = batch.message_ids[0]
        self.store = PostgresReplyStore(contract.TEST_DATABASE_URL)

    def _delete_source(self) -> None:
        self.observations.store.delete_observation(
            owner_id=self.scope.owner_id,
            contact_id=self.scope.contact_id,
            observation_id=self.source_id,
        )

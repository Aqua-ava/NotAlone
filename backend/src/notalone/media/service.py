"""单条媒体的公共接缝，隐藏具体来源、目录和尝试代次。"""

from datetime import datetime, timezone
import hashlib
import io
import math
from pathlib import Path
import re
import time
from typing import Any, Callable
from uuid import UUID, uuid4

import psycopg

from notalone.media.cache import ManagedMediaCache
from notalone.media.models import (
    ERROR_CODES, MediaArtifact, MediaAuthorization, MediaBudgets, MediaError,
    MediaProducer, MediaReadResult, MediaResult, OriginalMediaProducer,
    ProducedArtifact,
)
from notalone.persistence.media_store import PostgresMediaStore
from notalone.scopes import ContactScope
from notalone.wechat_media.locator import MediaLocation, MediaReader, UnverifiedMediaReader


VARIANT_PATTERN = re.compile(r"[a-zA-Z0-9_-]{1,64}")
EXPECTED_ROLES = {
    "original": {"managed_original"},
    "image": {"managed_original", "viewable_image"},
    "video": {"playable_video"},
    "voice": {"original_silk", "playable_wav"},
}


class MediaService:
    def __init__(
        self, database_url: str, cache_root: Path, *,
        reader: MediaReader | None = None,
        producer: MediaProducer | None = None,
        budgets: MediaBudgets | None = None,
        clock: Callable[[], datetime] | None = None,
        cache: ManagedMediaCache | None = None,
    ) -> None:
        self._clock = clock if clock is not None else lambda: datetime.now(timezone.utc)
        self._store = PostgresMediaStore(database_url, self._clock)
        root = Path(cache_root).absolute()
        self._cache = cache if cache is not None else ManagedMediaCache(
            root.parent.resolve() / root.name
        )
        self._reader = reader if reader is not None else UnverifiedMediaReader()
        self._producer = producer if producer is not None else OriginalMediaProducer()
        self._budgets = budgets if budgets is not None else MediaBudgets()

    @staticmethod
    def _result(row: dict[str, Any]) -> MediaResult:
        artifacts = tuple(
            MediaArtifact(
                UUID(item["artifact_id"]), item["role"], item["media_type"],
                item["size"], item["duration_seconds"],
            )
            for item in row["artifacts"]
        )
        return MediaResult("ready", row["resource_id"], row["source_ref_id"], artifacts)

    @staticmethod
    def _choose_location(
        authorization: MediaAuthorization,
        locations: tuple[MediaLocation, ...],
        variant: str | None,
    ) -> MediaLocation:
        if not locations:
            raise MediaError("resource_missing")
        if any(item.authorization != authorization for item in locations):
            raise MediaError("scope_mismatch")
        identities = {
            (item.dataset_id, item.message_shard, item.message_table,
             item.message_row, item.association_version)
            for item in locations
        }
        if any(
            not field for item in locations for field in (
                item.dataset_id, item.message_shard, item.message_table,
                item.message_row, item.resource_shard, item.resource_table,
                item.resource_row, item.association_version,
            )
        ):
            raise MediaError("upstream_unverified")
        if len(identities) != 1 or len({item.variant for item in locations}) != len(locations):
            raise MediaError("association_ambiguous")
        if any(not VARIANT_PATTERN.fullmatch(item.variant) for item in locations):
            raise MediaError("upstream_unverified")
        if len(locations) > 1 and variant is None:
            raise MediaError(
                "variant_ambiguous",
                variant_options=tuple(sorted(item.variant for item in locations)),
            )
        selected = [item for item in locations if variant is None or item.variant == variant]
        if len(selected) != 1:
            raise MediaError("resource_missing")
        return selected[0]

    def _produce(self, location: MediaLocation, target: str) -> tuple[ProducedArtifact, ...]:
        if isinstance(self._producer, OriginalMediaProducer) and target != "original":
            raise MediaError("unsupported_target")
        with self._reader.open(location) as source:
            data = source.read(self._budgets.max_input_bytes + 1)
        if len(data) > self._budgets.max_input_bytes:
            raise MediaError("budget_exceeded")
        if not data:
            raise MediaError("resource_missing")
        with io.BytesIO(data) as bounded_source:
            produced = self._producer.produce(bounded_source, target, self._budgets)
        expected_roles = EXPECTED_ROLES[target]
        if (
            not produced or len(produced) > self._budgets.max_artifacts
            or {item.role for item in produced} != expected_roles
            or len(produced) != len(expected_roles)
        ):
            raise MediaError("invalid_output")
        for item in produced:
            if (
                not isinstance(item.data, bytes) or not item.data
                or not re.fullmatch(r"[a-z]+/[a-zA-Z0-9.+-]+", item.media_type)
                or (item.duration_seconds is not None and (
                    not math.isfinite(item.duration_seconds)
                    or not 0 < item.duration_seconds <= self._budgets.max_duration_seconds
                ))
            ):
                raise MediaError("invalid_output")
        if sum(len(item.data) for item in produced) > self._budgets.max_output_bytes:
            raise MediaError("budget_exceeded")
        return produced

    def extract_media(
        self, scope: ContactScope, message_id: UUID, target: str, request_key: str,
        source_ref_id: UUID | None = None, variant: str | None = None,
    ) -> MediaResult:
        authorization = None
        row = None
        try:
            if (
                not isinstance(scope, ContactScope) or not isinstance(message_id, UUID)
                or (source_ref_id is not None and not isinstance(source_ref_id, UUID))
                or not isinstance(request_key, str) or not 1 <= len(request_key) <= 128
                or (variant is not None and not VARIANT_PATTERN.fullmatch(variant))
            ):
                raise MediaError("invalid_request")
            self._store.recover(scope)
            row, authorization, options = self._store.claim(
                scope, message_id, target, request_key, source_ref_id, variant,
                self._cache.root, self._budgets,
            )
            if authorization is None:
                return MediaResult("source_ambiguous", source_options=options)
            if row["status"] == "ready":
                row["claimed"] = True
                for artifact in row["artifacts"]:
                    self._store.read(scope, row["resource_id"], UUID(artifact["artifact_id"]))
                return self._result(row)
            if not row.get("claimed"):
                return MediaResult("preparing", row["resource_id"], row["source_ref_id"])
            started = time.monotonic()
            location = self._choose_location(
                authorization, self._reader.locate(authorization, target), row["variant"],
            )
            self._store.bind_location(row, location)
            with self._store.staging(row, self._cache) as fd:
                produced = self._produce(location, target)
                artifacts = []
                for item in produced:
                    artifact_id = uuid4()
                    self._cache.write(fd, artifact_id, item.data)
                    artifacts.append(dict(
                        artifact_id=str(artifact_id), role=item.role,
                        media_type=item.media_type, size=len(item.data),
                        duration_seconds=item.duration_seconds,
                        sha256=hashlib.sha256(item.data).hexdigest(),
                    ))
                if time.monotonic() - started > self._budgets.max_runtime_seconds:
                    raise MediaError("budget_exceeded")
                self._store.publish(row, self._cache, fd, artifacts, location.variant)
            row["artifacts"] = artifacts
            return self._result(row)
        except Exception as error:
            code = self._error_code(error)
            if row is not None and row.get("claimed"):
                try:
                    if not self._store.fail(row, code):
                        code = "attempt_invalidated"
                except (OSError, MediaError, psycopg.Error):
                    code = "cleanup_pending"
            choices: tuple[str, ...] = ()
            if (
                isinstance(error, MediaError) and error.code == "variant_ambiguous"
                and all(VARIANT_PATTERN.fullmatch(item) for item in error.variant_options)
            ):
                choices = error.variant_options
            return MediaResult(
                code, source_ref_id=authorization.source_ref_id if authorization else None,
                variant_options=choices,
            )

    @staticmethod
    def _error_code(error: Exception) -> str:
        if isinstance(error, MediaError) and error.code in ERROR_CODES:
            return error.code
        if isinstance(error, (OSError, psycopg.Error)):
            return "storage_failed"
        return "upstream_failed"

    def read_media(
        self, scope: ContactScope, resource_id: UUID, artifact_id: UUID,
    ) -> MediaReadResult:
        try:
            self._store.recover(scope, resource_id)
            data = self._store.read(scope, resource_id, artifact_id)
            return MediaReadResult("ready", io.BytesIO(data))
        except (MediaError, OSError, psycopg.Error) as error:
            return MediaReadResult(self._error_code(error))

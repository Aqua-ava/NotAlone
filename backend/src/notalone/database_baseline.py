"""经审查的 035 接管契约；基线与实际 SQL 执行记录分开保存。"""

from __future__ import annotations

from typing import Any

import psycopg


BASELINE_VERSION = 35
BASELINE_MANIFEST = (
    ('001_initial_ingest.sql', '266aa314034ddc6a90835431c6ceaf6a129db8dab413e5ef03ee0e1211981ced'),
    ('002_reject_overlapping_messages.sql', 'ab15a9bd53a1cc9f882f926d146dd23c9f6295e16c12e3821ad56fbc67e80ad3'),
    ('003_separate_contact_identity.sql', '667a77caf86520798f1ee7c3f33060e7b516c98206c7c707edc39bf73bfcab84'),
    ('004_separate_wechat_message_metadata.sql', 'f8627956db97c23588840b8320f1ad236d4e9d4e10309cd934f6f0beff65ca0e'),
    ('005_source_deletion_state.sql', '78477ac6f7698339a21e6ba988c56b497c9712d91046f8a05447e8d635f39877'),
    ('006_conversation_binding.sql', 'ffc713db0b396047c6ba7784b834797e9d76010f4710aa01335d71ba62d1bc80'),
    ('007_reply_store.sql', 'd499b548fef5447bbf879cc835a83af1dd002fb2fc2f4762d3788d00923b30f2'),
    ('008_skill_port.sql', '899794e2f597c03abd6c6ae886e6f4fc6cf27779cfbaaf9b78a09392a5be01f9'),
    ('009_memory_store.sql', '9f06a927cd91bf08bc6bc869fcbe10c994699c2f15e0bee37a55607ac88af134'),
    ('010_outbound_ledger.sql', 'd2cc7a2f4e28869dde82ec9af8e6a99b20dae0eeac79b6c82660c4b4504e443a'),
    ('011_owner_memory.sql', 'b6625e31e7e0c8dde5c1ccc2ee2cd0542bc0c160d7149b4f2538ba047b7e3c2b'),
    ('012_extraction_topic_watermark.sql', 'a89b89ff270ad3760930ac022621915eeddc3cc591203b1734ed9a1bd9bf65a6'),
    ('013_candidate_validity.sql', '4efaa08c7827ec1ab732695c2d2e27579e47557c153e79dd62641b496c6dc262'),
    ('014_import_message_identity.sql', 'b432b44299e62f7f654e0ae4f81359477b95e3e6914390934a0090e80aad16ba'),
    ('015_owner_channel_identity.sql', 'bd80538f71568d4a1136509159be5ec4715d45311fc6268212bd5ff1b29daecb'),
    ('016_background_task.sql', '149848b261c3dc142341916e1055517d505386cc3eee29683a72004054886e9e'),
    ('017_worker_lease_metadata.sql', '7066bcf16638124d08dc1bf8748768a1df7fb5eb69f4e7c46646b4fcb830ee9e'),
    ('018_contact_memory_index.sql', 'fc3107c0dc9d790bb0a27d3302ee9aa705e862928488ea91395bf5055496d363'),
    ('019_binding_cli_match_metadata.sql', '0020c3817520bc06bc20dd1e1d5f0ec7c2fa1e6d7859f16fd1abcc41360f7249'),
    ('020_local_wechat_observation.sql', 'acfbfbbcc323e1d1e45cc12a05b63bc95a914abda0f84b6d6f9bc87d068ab8bb'),
    ('021_message_source_ref.sql', '31ed56a17f363d29a9f4f29ed107930567dc99fab52e31b40cc9dcef25abc37e'),
    ('022_front_sync_state.sql', 'a4457c7bc998b817fef8a0d44c296490a15df007562343477bf495306507edb0'),
    ('023_skill_library_resources.sql', '1c12e16e68952080078ec0f6fc31c4a07c743fe1f5ed157d1ab5ce61101015a8'),
    ('024_skill_run_record.sql', '1299bfb6ab64fd6b78eefecb908e6c526f634a8dabc95fbcb63cf207a10233ac'),
    ('025_manual_memory_source.sql', '4b3e3cd06f8944bb48696075e9d0b0cb39a0bf5adc4c38efed4fc463731490c4'),
    ('026_cli_background_sync.sql', '23d6fdbf1ac8b153c3e5911c2c1743e36606b4b4dc02fe11a7d6c43ce2858934'),
    ('027_memory_adoption_provenance.sql', '50067e0280bd005722f4486374880d38d6922d8087b5f0eb39861cd103a5ef4e'),
    ('028_reply_context_evidence_metadata.sql', '3eb47e59ade749f730459146b94dd52e93f23f07b8c76f41a524a0c15cbb7c88'),
    ('029_cli_backfill_state.sql', 'dbf920f0d4dd4ac551c4593c9bdaac1fb8e0c5891695be63312c756d4b853db0'),
    ('030_cli_observation_reliability_and_progress.sql', '918ab49b1ccf9ca8a2fec23f3dddad297726dfda94ec78ae46e463ad4f149bb9'),
    ('031_cli_backfill_scheduler.sql', '187addae01a9c5c8bd0d4a5294f07e76a07d535b63d2d407e7911d9960d37184'),
    ('032_memory_candidate_subject.sql', 'c8c7073308c66135abadf59d899055eadb44c0e82b12e19a4871d4b1f99f5964'),
    ('033_owner_memory_evidence_kind.sql', 'dced994989341ccba424bddc68889415d6810e4c86be7ed68b46a16b885ee672'),
    ('034_extraction_failure_recovery.sql', 'a78d5bde2c9bc07c8681acf6d6f6512b40895b2fdedc3b3ed87f54dbea40381b'),
    ('035_extraction_watermark_cascade.sql', '866aac5fc8e0bbfb3ad61315b3fef290587f760289ed1af95bc4a9867238b974'),
)


class BaselineError(ValueError):
    """接管基线不满足固定契约；仅含稳定分类。"""


def validate_prefix(migrations: tuple[Any, ...]) -> None:
    actual = tuple((item.name, item.checksum) for item in migrations[:BASELINE_VERSION])
    if actual != BASELINE_MANIFEST:
        raise BaselineError("baseline_files_mismatch：035 接管契约的迁移文件缺失或内容改变。")


def baseline_offset(connection: psycopg.Connection[Any], migrations: tuple[Any, ...]) -> int:
    if connection.execute(
        "SELECT pg_catalog.to_regclass('public.notalone_schema_baseline')"
    ).fetchone()[0] is None:
        return 0
    rows = connection.execute(
        "SELECT format_version, through_version, manifest, backup_sha256, "
        "restore_verified_at FROM public.notalone_schema_baseline"
    ).fetchall()
    if len(rows) != 1 or rows[0][:2] != (1, BASELINE_VERSION):
        raise BaselineError("baseline_invalid：审计基线格式或数量无效。")
    validate_prefix(migrations)
    expected = [{"name": name, "checksum": checksum} for name, checksum in BASELINE_MANIFEST]
    if rows[0][2] != expected or rows[0][3] is None or rows[0][4] is None:
        raise BaselineError("baseline_invalid：审计基线缺少文件或恢复验证凭证。")
    if connection.execute(
        "SELECT pg_catalog.to_regclass('public.notalone_schema_migration')"
    ).fetchone()[0] is None:
        raise BaselineError("baseline_invalid：审计基线的实际迁移账本缺失。")
    return BASELINE_VERSION

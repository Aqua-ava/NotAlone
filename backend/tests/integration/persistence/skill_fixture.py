"""合成固定身份夹具：发布受控快照，数据库只写业务与完整性状态。"""

from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import UUID

from notalone.persistence.skill_files import (
    queue_working_copy, synchronize_working_copies, write_version_package,
)
from notalone.persistence.skill_manifest import write_package_manifest
from notalone.skills import LocalSkillPackageReader, SkillPackageValidator


def insert_file_skill(connection, *, owner_id, skill_id, version_id, name,
                      content, description="合成教学策略。", contact_id=None,
                      version_number=1, enabled=True, is_current=True,
                      skill_status="active", status="active", create_skill=True,
                      resources=None, write_working=True):
    """业务夹具通过同一文件发布入口建立，不仿造已退役的数据库正文列。"""
    if not os.environ.get("NOTALONE_SKILLS_DIR"):
        raise RuntimeError("合成 Skill 夹具必须显式指定临时 Skill 根目录。")
    if create_skill:
        connection.execute(
            "INSERT INTO public.reply_skill(id,owner_id,contact_id,name,status,deleted_at) "
            "VALUES (%s,%s,%s,%s,%s,%s)",
            (skill_id, owner_id, contact_id, name, skill_status,
             datetime.now(timezone.utc) if skill_status == "deleted" else None))
    path = document_digest = manifest_digest = content_digest = None
    if content is not None:
        with TemporaryDirectory() as temporary:
            package_path = Path(temporary) / name
            package_path.mkdir()
            (package_path / "SKILL.md").write_text(
                "---\nname: " + name + "\ndescription: " + json.dumps(description, ensure_ascii=False)
                + "\n---\n\n" + content, encoding="utf-8")
            for relative, data in (resources or {}).items():
                resource_path = package_path / relative
                resource_path.parent.mkdir(parents=True, exist_ok=True)
                resource_path.write_bytes(data)
            package = SkillPackageValidator().validate(LocalSkillPackageReader().read(package_path))
        path, document_digest = write_version_package(
            owner_id=UUID(str(owner_id)), skill_id=UUID(str(skill_id)),
            version_id=UUID(str(version_id)), package=package)
        manifest_digest = write_package_manifest(path, package)
        content_digest = sha256(content.encode("utf-8")).hexdigest()
    connection.execute(
        "INSERT INTO public.reply_skill_version(id,skill_id,version_number,enabled,is_current,status,deleted_at,"
        "content_path,document_sha256,manifest_sha256,content_sha256) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (version_id, skill_id, version_number, enabled, is_current, status,
         datetime.now(timezone.utc) if status == "deleted" else None,
         path, document_digest, manifest_digest, content_digest))
    if path is not None and is_current and status == "active" and skill_status != "deleted":
        queue_working_copy(connection, skill_id, version_id)
        if write_working:
            synchronize_working_copies(connection, owner_id=UUID(str(owner_id)))

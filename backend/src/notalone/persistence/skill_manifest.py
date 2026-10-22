"""不可变版本的无正文目录清单；数据库仅锚定完整性与业务资格。"""

import hashlib
import json
import os
import re
from pathlib import PurePosixPath
from uuid import uuid4

from notalone.persistence.skill_files import SkillFileError, _checked_path, _version_row
from notalone.skills import LocalSkillPackageReader
from notalone.skills.models import validate_resource_relative_path
from notalone.skills.package import MAX_DESCRIPTION_LENGTH, MAX_RESOURCE_BYTES, MAX_RESOURCE_COUNT, MAX_RESOURCE_TOTAL_BYTES


def _manifest_locator(content_path):
    if not isinstance(content_path, str) or not content_path.endswith('/SKILL.md'):
        raise SkillFileError('Skill 清单不可用。')
    return str(PurePosixPath(content_path).parent.parent / 'manifest.json')


def package_manifest(package):
    """清单不含正文；资源身份使用相对路径，排序不受数据库 collation 影响。"""
    return {
        'schema_version': 1,
        'name': package.name,
        'description': package.description,
        'warnings': list(package.warnings),
        'resources': [
            {'relative_path': resource.relative_path, 'resource_kind': resource.resource_kind,
             'media_type': resource.media_type, 'byte_size': len(resource.content),
             'content_sha256': resource.content_sha256}
            for resource in sorted(package.resources, key=lambda item: item.relative_path)
        ],
    }


def write_package_manifest(content_path, package):
    """只创建或复验清单；失败不覆盖已发布文件。返回供事务保存的 SHA256。"""
    path = _checked_path(_manifest_locator(content_path))
    data = json.dumps(package_manifest(package), ensure_ascii=False,
                      sort_keys=True, separators=(',', ':')).encode('utf-8')
    temporary = path.with_name('.manifest-' + uuid4().hex)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if path.exists():
            if LocalSkillPackageReader._read_file(path.parent, path.name, MAX_RESOURCE_BYTES) != data:
                raise SkillFileError('不可变 Skill 清单不一致。')
        else:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        return hashlib.sha256(data).hexdigest()
    except (OSError, ValueError):
        raise SkillFileError('Skill 清单发布失败。') from None
    finally:
        temporary.unlink(missing_ok=True)


def _validate_manifest(raw, name):
    try:
        if (not isinstance(raw, dict) or set(raw) != {'schema_version', 'name', 'description', 'warnings', 'resources'}
                or raw['schema_version'] != 1 or raw['name'] != name
                or not isinstance(raw['description'], str) or not raw['description'].strip()
                or len(raw['description']) > MAX_DESCRIPTION_LENGTH
                or not isinstance(raw['warnings'], list) or any(not isinstance(item, str) for item in raw['warnings'])
                or not isinstance(raw['resources'], list) or len(raw['resources']) > MAX_RESOURCE_COUNT):
            raise ValueError()
        seen, total = set(), 0
        for resource in raw['resources']:
            if not isinstance(resource, dict) or set(resource) != {
                    'relative_path', 'resource_kind', 'media_type', 'byte_size', 'content_sha256'}:
                raise ValueError()
            relative = resource['relative_path']
            validate_resource_relative_path(relative)
            if (relative in seen or resource['resource_kind'] != ('reference' if relative.startswith('references/') else 'asset')
                    or not isinstance(resource['media_type'], str) or not resource['media_type'].strip()
                    or type(resource['byte_size']) is not int or not 0 <= resource['byte_size'] <= MAX_RESOURCE_BYTES
                    or not isinstance(resource['content_sha256'], str)
                    or re.fullmatch('[0-9a-f]{64}', resource['content_sha256']) is None):
                raise ValueError()
            seen.add(relative)
            total += resource['byte_size']
        if total > MAX_RESOURCE_TOTAL_BYTES:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise SkillFileError('Skill 清单校验失败。') from None
    return raw


def read_package_manifest(connection, version_id):
    """只读小型无正文清单，不读取 SKILL.md、资源或方法指令。"""
    row = _version_row(connection, version_id)
    expected = f".versions/{row['owner_id']}/{row['skill_id']}/{row['id']}/{row['name']}/SKILL.md"
    if row['content_path'] != expected:
        raise SkillFileError('Skill 清单不可用。')
    path = _checked_path(_manifest_locator(expected))
    try:
        data = LocalSkillPackageReader._read_file(path.parent, path.name, MAX_RESOURCE_BYTES)
        if hashlib.sha256(data).hexdigest() != row['manifest_sha256']:
            raise ValueError()
        return _validate_manifest(json.loads(data), row['name'])
    except (OSError, KeyError, TypeError, ValueError):
        raise SkillFileError('Skill 清单不可用。') from None


def project_manifest_metadata(connection, row):
    """将文件元数据投影到既有运行合同，不制造第二份持久化内容。"""
    manifest = row.get('_manifest') or read_package_manifest(connection, row['version_id'])
    return {**row, '_manifest': manifest, 'version_name': manifest['name'],
            'version_description': manifest['description'], 'skill_description': manifest['description']}

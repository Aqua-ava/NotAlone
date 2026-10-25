"""只从固定旧提交的生产依赖锁准备隔离评测解释器。"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request


def normalized(name: str) -> str:
    return re.sub(r'[-_.]+', '-', name).lower()


def prepare_legacy_runtime(state: Path, old: Path, bootstrap: str,
                           environment: dict, wheel_cache: Path | None = None) -> tuple[str, dict]:
    lock = old / 'desktop/scripts/runtime/requirements.lock'
    catalog = old / 'desktop/scripts/runtime/python-wheels.lock.json'
    wheels = json.loads(catalog.read_text())
    entries = {}
    for line in lock.read_text().splitlines():
        match = re.fullmatch(r'([^=\s]+)==([^\s]+) --hash=sha256:([0-9a-f]{64})', line)
        if not match:
            raise ValueError('legacy_requirements_lock_invalid')
        entries[normalized(match[1])] = (match[2], match[3])
    if len(entries) != len(wheels):
        raise ValueError('legacy_wheel_closure_mismatch')
    for wheel in wheels:
        url = urllib.parse.urlparse(wheel['url'])
        if (Path(wheel['filename']).name != wheel['filename'] or
                url.scheme != 'https' or url.hostname != 'files.pythonhosted.org' or
                entries.get(normalized(wheel['name'])) != (wheel['version'], wheel['sha256'])):
            raise ValueError('legacy_wheel_provenance_invalid')
    wheelhouse = state / 'old-wheelhouse'
    wheelhouse.mkdir()
    deadline = time.monotonic() + 120

    def obtain(wheel: dict) -> None:
        target = wheelhouse / wheel['filename']
        cached = wheel_cache / wheel['filename'] if wheel_cache else None
        if cached and cached.is_file():
            shutil.copyfile(cached, target)
        else:
            # 不使用代理、凭据、索引搜索或可变版本；只下载归档内固定 URL。
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(wheel['url'], timeout=20) as response, target.open('wb') as stream:
                while block := response.read(1024 * 1024):
                    if time.monotonic() > deadline:
                        raise TimeoutError('legacy_wheel_download_deadline')
                    stream.write(block)
        if hashlib.sha256(target.read_bytes()).hexdigest() != wheel['sha256']:
            raise ValueError('legacy_wheel_sha256_mismatch:' + wheel['filename'])

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(obtain, wheels))
    runtime = state / 'old-runtime'
    subprocess.run([bootstrap, '-m', 'venv', str(runtime)], env=environment,
                   check=True, capture_output=True, timeout=30)
    python = runtime / 'bin/python'
    install_environment = {**environment, 'PIP_CONFIG_FILE': '/dev/null',
                           'PIP_NO_INDEX': '1', 'PIP_DISABLE_PIP_VERSION_CHECK': '1',
                           'PIP_REQUIRE_VIRTUALENV': '1', 'PYTHONNOUSERSITE': '1'}
    subprocess.run([str(python), '-m', 'pip', 'install', '--no-index', '--no-deps',
                    '--no-compile', '--require-hashes', '--find-links', str(wheelhouse),
                    '--progress-bar', 'off', '-r', str(lock)],
                   env=install_environment, check=True, capture_output=True, timeout=90)
    script = ('import importlib.metadata as m,json,sys; '
              'print(json.dumps({"prefix":sys.prefix,"base_prefix":sys.base_prefix,'
              '"version":list(sys.version_info[:2]),'
              '"distributions":{d.metadata["Name"]:d.version for d in m.distributions()}}))')
    observed = json.loads(subprocess.check_output([str(python), '-c', script],
                          env=install_environment, text=True, timeout=10))
    actual = {normalized(k): v for k, v in observed['distributions'].items()}
    if (Path(observed['prefix']) != runtime or observed['prefix'] == observed['base_prefix'] or
            observed['version'] != [3, 12] or
            any(actual.get(name) != version for name, (version, _digest) in entries.items())):
        raise ValueError('legacy_runtime_isolation_or_version_mismatch')
    return str(python), {
        'isolated': True, 'system_site_packages': False,
        'requirements_sha256': hashlib.sha256(lock.read_bytes()).hexdigest(),
        'wheel_catalog_sha256': hashlib.sha256(catalog.read_bytes()).hexdigest(),
        'wheel_count': len(wheels), 'packages': {name: version for name, (version, _) in sorted(entries.items())},
        'bootstrap_python_sha256': hashlib.sha256(Path(bootstrap).read_bytes()).hexdigest(),
        'dependency_source': 'archived-production-requirements-and-wheel-hashes',
    }

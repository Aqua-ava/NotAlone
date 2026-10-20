"""提取固定基线与当前生产布局，锁内交错计时；仅使用合成图像。"""
import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
CORE = 'native/macos/Sources/NotAloneSyncCore/'


def declaration(source: str, name: str) -> str:
    start = source.index(name)
    opening = source.index('{', start)
    depth, end = 1, opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', default='681fcc38eab77c8fe149b76705419971f3750a86')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    baseline = subprocess.check_output(
        ['git', 'rev-parse', '--verify', args.baseline + '^{commit}'], cwd=ROOT, text=True).strip()
    names = ['CaptureSupport.swift', 'AutomaticSessionCapture.swift']
    old = {name: subprocess.check_output(
        ['git', 'show', f'{baseline}:{CORE}{name}'], cwd=ROOT, text=True) for name in names}
    current = {name: (ROOT / CORE / name).read_text() for name in names}
    source = '''import Foundation
import CoreGraphics
enum MinimalSessionError: Error { case layoutUnverified }
enum AutomaticLayoutFailure: String, Error {
    case vertical, header, selection, rail
}
struct ChatRegionDetector {
''' + declaration(old[names[0]], 'static func luminancePixels(') + '\n' + declaration(
        old[names[0]], 'static func medianOf(') + '\n}\n'
    source += declaration(current[names[0]], 'struct LuminanceSampler {') + '\n'
    source += declaration(old[names[1]], 'struct AutomaticSessionRegions {').replace(
        'struct AutomaticSessionRegions {', 'struct Baseline {', 1) + '\n'
    source += declaration(current[names[1]], 'struct AutomaticSessionRegions {').replace(
        'struct AutomaticSessionRegions {', 'struct Candidate {', 1) + '\n'
    source += (Path(__file__).parent / 'LayoutBenchmark.swift').read_text()
    with tempfile.TemporaryDirectory(prefix='notalone-native-layout-') as directory:
        path = Path(directory)
        (path / 'benchmark.swift').write_text(source)
        subprocess.run(['swiftc', '-O', '-parse-as-library', str(path / 'benchmark.swift'),
                        '-o', str(path / 'benchmark')], check=True)
        # 与其他优化分支共享同一把锁；编译不占用计时锁。
        with open('/tmp/notalone-optimization-benchmark.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = json.loads(subprocess.check_output([str(path / 'benchmark')], text=True))
    result['baseline_commit'] = baseline
    result['source_sha256'] = {
        stage: {name: hashlib.sha256(text.encode()).hexdigest() for name, text in texts.items()}
        for stage, texts in [('baseline', old), ('candidate', current)]}
    result['driver_sha256'] = hashlib.sha256(source.encode()).hexdigest()
    result['swift_version'] = subprocess.check_output(['swiftc', '--version'], text=True).strip()
    result['memory_scope'] = '未测RSS；不从数组大小推断进程内存。候选缓冲区仅在当轮布局闭包存活。'
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: value for key, value in result.items() if key in
                      ['equivalence_images', 'scope', 'baseline_commit']}, ensure_ascii=False))
    for item in result['results']:
        print(json.dumps({key: value for key, value in item.items() if not key.endswith('_samples_ms')}))


if __name__ == '__main__':
    main()

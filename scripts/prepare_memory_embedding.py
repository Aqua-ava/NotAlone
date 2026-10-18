"""准备固定版本中文向量模型；仅下载公开权重，不读取聊天或业务配置。"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

MODEL = 'BAAI/bge-small-zh-v1.5'
REPOSITORY = 'Qdrant/bge-small-zh-v1.5'
REVISION = '46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path(os.environ.get(
        'NOTALONE_MEMORY_EMBEDDING_CACHE', str(Path.home() / '.cache/notalone/memory-embedding'))))
    parser.add_argument('--offline', action='store_true', help='只验证已下载的固定版本，不联网')
    args = parser.parse_args()
    from fastembed import TextEmbedding
    from huggingface_hub import snapshot_download

    directory = args.cache / 'models--Qdrant--bge-small-zh-v1.5' / 'snapshots' / REVISION
    if not args.offline:
        snapshot_download(REPOSITORY, revision=REVISION, cache_dir=str(args.cache),
                          allow_patterns=['*.json', '*.txt', 'model_optimized.onnx'])
    model = TextEmbedding(MODEL, specific_model_path=str(directory), local_files_only=True, threads=2)
    vector = next(model.embed(['本地中文向量模型自检。']))
    if len(vector) != 512:
        raise RuntimeError('固定模型向量维数不匹配。')
    print(json.dumps({'model': MODEL, 'revision': REVISION, 'dimensions': len(vector),
                      'offline_inference': True}, ensure_ascii=False))


if __name__ == '__main__':
    main()

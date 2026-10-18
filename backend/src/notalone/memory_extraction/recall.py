"""同范围当前记忆的词法与本机语义召回；不保存原文或向量缓存。"""
from collections import Counter
from math import log, sqrt, isfinite
import os
from pathlib import Path
import re
from threading import Lock

_MODEL = None
_MODEL_LOCK = Lock()


class EmbeddingUnavailableError(OSError):
    """本机语义模型缺失、加载或推理失败，可安全显示的准备提示。"""


EMBEDDING_UNAVAILABLE = ('embedding_unavailable：本机语义模型不可用；请在项目根目录使用 NotAlone Python 环境运行 '
    'python scripts/prepare_memory_embedding.py 准备模型。候选保留待处理，运行时不会下载模型。')


def embed_texts(texts):
    """仅加载预置本机模型，禁止隐式下载或向外部发送资料。"""
    global _MODEL
    with _MODEL_LOCK:
        try:
            if _MODEL is None:
                from fastembed import TextEmbedding
                cache = Path(os.environ.get('NOTALONE_MEMORY_EMBEDDING_CACHE',
                    str(Path.home() / '.cache/notalone/memory-embedding')))
                snapshot = cache / 'models--Qdrant--bge-small-zh-v1.5/snapshots/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59'
                if not (snapshot / 'model_optimized.onnx').is_file():
                    raise OSError('本机模型未准备。')
                _MODEL = TextEmbedding(model_name='BAAI/bge-small-zh-v1.5',
                    cache_dir=str(cache), specific_model_path=str(snapshot), local_files_only=True, threads=2)
            return [tuple(float(value) for value in row) for row in _MODEL.embed(texts)]
        except Exception as error:
            raise EmbeddingUnavailableError(EMBEDDING_UNAVAILABLE) from error



def _tokens(text):
    words = re.findall(r'[a-z0-9]+|[\u3400-\u9fff]+', text.lower())
    return [token for word in words for token in
            ([word] if re.match('[a-z0-9]', word) or len(word) == 1 else
             [word[i:i + 2] for i in range(len(word) - 1)])]


def hybrid_candidates(texts, pool, *, top_k=5):
    """BM25和余弦排名RRF融合；跨类别召回，最终由模型裁决是否相关。"""
    if not pool:
        return [[] for _ in texts]
    vectors = embed_texts([*texts, *(item.text for item in pool)])
    if (len(vectors) != len(texts) + len(pool) or not vectors or not vectors[0]
            or any(len(row) != len(vectors[0]) or not all(isfinite(x) for x in row) for row in vectors)):
        raise ValueError('本机embedding输出不符合维度契约。')
    docs = [Counter(_tokens(item.text)) for item in pool]
    lengths = [sum(doc.values()) for doc in docs]
    mean = sum(lengths) / len(docs) or 1
    df = Counter(token for doc in docs for token in doc)
    result = []
    for query_index, text in enumerate(texts):
        query = vectors[query_index]
        norm = sqrt(sum(x*x for x in query))
        semantic = []
        lexical = []
        for index, (item, doc) in enumerate(zip(pool, docs)):
            vector = vectors[len(texts) + index]
            denominator = norm * sqrt(sum(x*x for x in vector))
            cosine = sum(a*b for a,b in zip(query, vector)) / denominator if denominator else 0
            semantic.append((cosine, index))
            score = sum(log(1 + (len(docs) - df[token] + .5) / (df[token] + .5))
                        * doc[token] * 2.2 / (doc[token] + 1.2 * (.25 + .75 * lengths[index] / mean))
                        for token in set(_tokens(text)) if doc[token])
            if score > 0:
                lexical.append((score, index))
        scores = Counter()
        for ranking in (semantic, lexical):
            for rank, (_, index) in enumerate(sorted(ranking, key=lambda row: (-row[0], str(pool[row[1]].memory_id)))[:top_k]):
                scores[index] += 1 / (60 + rank + 1)
        result.append([pool[index] for index in sorted(scores, key=lambda index: (-scores[index], str(pool[index].memory_id)))[:top_k]])
    return result

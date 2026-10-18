"""同范围当前记忆的词法与本机语义召回；不保存原文或向量缓存。"""
from collections import Counter
from math import log, sqrt, isfinite
import os
from pathlib import Path
from threading import Lock

from notalone.retrieval.lexical import tokenize

_MODEL = None
_MODEL_LOCK = Lock()


class EmbeddingUnavailableError(OSError):
    """本机语义模型缺失、加载或推理失败，可安全显示的准备提示。"""


EMBEDDING_UNAVAILABLE = ('embedding_unavailable：本机语义模型不可用；请在项目根目录使用 NotAlone Python 环境运行 '
    'python scripts/prepare_memory_embedding.py 准备模型。本轮未写入记忆，准备后可重试；运行时不会下载模型。')


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



def hybrid_candidates(texts, pool, *, top_k=5):
    """BM25和余弦排名RRF融合；跨类别召回，最终由模型裁决是否相关。"""
    if not pool:
        return [[] for _ in texts]
    vectors = embed_texts([*texts, *(item.text for item in pool)])
    if (len(vectors) != len(texts) + len(pool) or not vectors or not vectors[0]
            or any(len(row) != len(vectors[0]) or not all(isfinite(x) for x in row) for row in vectors)):
        raise ValueError('本机embedding输出不符合维度契约。')
    result = []
    for query_index, text in enumerate(texts):
        query = vectors[query_index]
        norm = sqrt(sum(x*x for x in query))
        semantic = []
        lexical = [(score, index) for index, score in enumerate(bm25_scores(text, [item.text for item in pool])) if score > 0]
        for index, item in enumerate(pool):
            vector = vectors[len(texts) + index]
            denominator = norm * sqrt(sum(x*x for x in vector))
            cosine = sum(a*b for a,b in zip(query, vector)) / denominator if denominator else 0
            semantic.append((cosine, index))
        scores = Counter()
        for ranking in (semantic, lexical):
            for rank, (_, index) in enumerate(sorted(ranking, key=lambda row: (-row[0], str(pool[row[1]].memory_id)))[:top_k]):
                scores[index] += 1 / (60 + rank + 1)
        result.append([pool[index] for index in sorted(scores, key=lambda index: (-scores[index], str(pool[index].memory_id)))[:top_k]])
    return result


def bm25_scores(query: str, texts: list[str]) -> list[float]:
    """复用中文双字/拉丁词法，按文档频率及长度归一化排序。"""
    def terms(text):
        return [token.text for token in tokenize(text) if len(token.text) >= 2]
    documents = [Counter(terms(text)) for text in texts]
    if not documents:
        return []
    query_terms = set(terms(query))
    lengths = [sum(document.values()) for document in documents]
    average = sum(lengths) / len(lengths) or 1
    frequency = Counter(term for document in documents for term in document)
    scores = []
    for document, length in zip(documents, lengths):
        score = 0.0
        for term in query_terms:
            count = document[term]
            if not count:
                continue
            inverse = log(1 + (len(documents) - frequency[term] + 0.5) / (frequency[term] + 0.5))
            score += inverse * count * 2.2 / (count + 1.2 * (0.25 + 0.75 * length / average))
        scores.append(score)
    return scores

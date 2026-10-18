"""L1 裁决前的本地 BM25 召回；不调用外部 embedding。"""
from collections import Counter
from math import log

from notalone.retrieval.lexical import tokenize


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

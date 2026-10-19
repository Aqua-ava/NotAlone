"""只用合成资料对照固定基线；计数、计时、Python 峰值内存分别执行。"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import gc
import hashlib
import importlib.metadata
import json
from math import ceil
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time
import tracemalloc
from types import ModuleType, SimpleNamespace
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "backend/src/notalone/memory_extraction/recall.py"
LEXICAL = "backend/src/notalone/retrieval/lexical.py"
BASELINE = "746bb40b7a0a90105c39f76d2786c451a55c93f7"
SNAPSHOT = "models--Qdrant--bge-small-zh-v1.5/snapshots/46fbe35fd4374a00fee7de77dfddaeb6dd6a2c59"


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def load_source(name: str, source: str) -> ModuleType:
    module = ModuleType(name)
    exec(compile(source, f"<{name}>", "exec"), module.__dict__)
    return module


@contextmanager
def replace(module: ModuleType, **values):
    previous = {key: getattr(module, key) for key in values}
    try:
        for key, value in values.items():
            setattr(module, key, value)
        yield
    finally:
        for key, value in previous.items():
            setattr(module, key, value)


def fixture(size: int, queries: int, dimension: int):
    activities = ("游泳", "跑步", "读书", "喝茶", "骑车", "散步", "咖啡")
    texts = [f"合成候选{i}：周末喜欢{activities[i % 7]}，地点在社区。" for i in range(queries)]
    pool = [SimpleNamespace(memory_id=UUID(int=i + 1),
            text=f"合成资料{i}：每周{i % 7}固定{activities[i % 7]}，地点在社区{i % 11}。")
            for i in reversed(range(size))]
    combined = [*texts, *(item.text for item in pool)]
    vectors = [tuple((digest[i % len(digest)] - 127) / 128 for i in range(dimension))
               for text in combined for digest in [hashlib.sha256(text.encode()).digest()]]
    fingerprint = hashlib.sha256(json.dumps(combined, ensure_ascii=False).encode()).hexdigest()
    return texts, pool, vectors, fingerprint


def identifiers(rows) -> list[list[str]]:
    return [[str(item.memory_id) for item in row] for row in rows]


def summary(samples: list[float]) -> dict:
    return {"samples_ms": samples, "n": len(samples), "median_ms": statistics.median(samples),
            "min_ms": min(samples), "max_ms": max(samples),
            "p95_nearest_rank_ms": sorted(samples)[ceil(.95 * len(samples)) - 1] if len(samples) >= 20 else None}


def count(module, texts, pool, vectors) -> dict:
    counts = {"tokenize": 0, "sqrt": 0, "embedding_inputs": []}
    original_tokenize, original_sqrt = module.tokenize, module.sqrt

    def tokenize(text):
        counts["tokenize"] += 1
        return original_tokenize(text)

    def sqrt(value):
        counts["sqrt"] += 1
        return original_sqrt(value)

    def embed(values):
        counts["embedding_inputs"].append(len(values))
        return vectors

    with replace(module, tokenize=tokenize, sqrt=sqrt, embed_texts=embed):
        rows = module.hybrid_candidates(texts, pool)
    return {**counts, "ordered_ids": identifiers(rows)}


def verify(baseline, current, texts, pool, vectors) -> None:
    corpus = [item.text for item in pool]
    for query in texts:
        if baseline.bm25_scores(query, corpus) != current.bm25_scores(query, corpus):
            raise AssertionError("BM25 分数不完全一致。")
    expected = None
    for module in (baseline, current):
        with replace(module, embed_texts=lambda values: vectors):
            result = identifiers(module.hybrid_candidates(texts, pool))
        if expected is not None and result != expected:
            raise AssertionError("有序召回 ID 不一致。")
        expected = result


def measure(modules, texts, pool, samples: int, *, memory: bool = False) -> dict:
    if memory:
        peaks = {}
        for name, module in modules.items():
            gc.collect()
            tracemalloc.start()
            module.hybrid_candidates(texts, pool)
            _, peaks[name] = tracemalloc.get_traced_memory()
            tracemalloc.stop()
        return {"python_peak_bytes": peaks, "excludes": "预建向量输入、原生模型及 RSS；包含本次召回分配"}
    for module in modules.values():
        module.hybrid_candidates(texts, pool)
    timings = {name: [] for name in modules}
    expected = None
    for sample in range(samples):
        order = list(modules.items())[::1 if sample % 2 == 0 else -1]
        for name, module in order:
            started = time.perf_counter()
            rows = module.hybrid_candidates(texts, pool)
            timings[name].append((time.perf_counter() - started) * 1000)
            result = identifiers(rows)
            if expected is not None and result != expected:
                raise AssertionError("计时轮次的有序 ID 不一致。")
            expected = result
    return {name: summary(values) for name, values in timings.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-ref", default=BASELINE)
    parser.add_argument("--mode", choices=("count", "timing", "memory", "local"), required=True)
    parser.add_argument("--sizes", nargs="+", type=int, default=[100, 1000, 10000])
    parser.add_argument("--queries", type=int, default=20)
    parser.add_argument("--dimension", type=int, default=16)
    parser.add_argument("--samples", type=int, default=21)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("PYTHONHASHSEED") != "0":
        parser.error("请显式设置 PYTHONHASHSEED=0，固定 query 集合累加顺序。")
    if min(*args.sizes, args.queries, args.dimension, args.samples) < 1:
        parser.error("负载及样本数必须为正整数。")
    if args.mode == "local" and len(args.sizes) != 1:
        parser.error("真实编码每次进程只接受一个池尺寸，以区分首次加载。")
    baseline_sha = git("rev-parse", f"{args.baseline_ref}^{{commit}}")
    os.environ.update(NOTALONE_DISABLE_DOTENV="1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT / "backend/src"))
    if git("show", f"{baseline_sha}:{LEXICAL}") != (ROOT / LEXICAL).read_text().strip():
        raise RuntimeError("词法实现不同，不能宣称只比较召回复用。")
    source = (ROOT / SOURCE).read_text()
    baseline = load_source("baseline_recall", git("show", f"{baseline_sha}:{SOURCE}"))
    current = load_source("current_recall", source)
    modules = {"baseline": baseline, "current": current}
    report = {"mode": args.mode, "baseline_sha": baseline_sha, "worktree_head": git("rev-parse", "HEAD"),
              "current_source_sha256": hashlib.sha256(source.encode()).hexdigest(),
              "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "python": sys.version, "executable": sys.executable, "platform": platform.platform(),
              "hash_seed": "0", "queries": args.queries, "fixed_vector_dimension": args.dimension,
              "timing_order": "各预热一次；奇偶轮交替 baseline/current 顺序；perf_counter；不启用 tracemalloc",
              "results": []}
    if args.mode == "local":
        cache = Path(os.environ.get("NOTALONE_MEMORY_EMBEDDING_CACHE", Path.home() / ".cache/notalone/memory-embedding"))
        required = ("model_optimized.onnx", "config.json", "ort_config.json", "tokenizer.json",
                    "tokenizer_config.json", "special_tokens_map.json", "vocab.txt")
        assets = {name: (cache / SNAPSHOT / name).stat().st_size for name in required}
        report.update(local_assets=assets, model_snapshot=SNAPSHOT,
                      fastembed_version=importlib.metadata.version("fastembed"),
                      cold_note="每个模块首次加载加完整召回；顺序固定旧→新，OS 文件缓存未清除，不作为稳定态收益")
    for size in args.sizes:
        texts, pool, vectors, digest = fixture(size, args.queries, args.dimension)
        verify(baseline, current, texts, pool, vectors)
        result = {"pool_size": size, "input_sha256": digest, "exact_bm25_and_ordered_ids_equal": True}
        if args.mode == "count":
            result.update({name: count(module, texts, pool, vectors) for name, module in modules.items()})
        elif args.mode == "local":
            if any(module._MODEL is not None for module in modules.values()):
                raise RuntimeError("真实编码每次进程只测一个池尺寸，以区分首次加载。")
            encoding = {name: [] for name in modules}

            def measured_encoder(name, original):
                def embed(values):
                    started = time.perf_counter()
                    vectors = original(values)
                    encoding[name].append({"elapsed_ms": (time.perf_counter() - started) * 1000,
                                           "inputs": len(values), "dimension": len(vectors[0])})
                    return vectors
                return embed

            cold, expected = {}, None
            with replace(baseline, embed_texts=measured_encoder("baseline", baseline.embed_texts)), replace(
                current, embed_texts=measured_encoder("current", current.embed_texts),
            ):
                for name, module in modules.items():
                    started = time.perf_counter()
                    rows = identifiers(module.hybrid_candidates(texts, pool))
                    cold[name] = (time.perf_counter() - started) * 1000
                    if expected is not None and rows != expected:
                        raise AssertionError("真实模型有序召回 ID 不一致。")
                    expected = rows
                steady_state = measure(modules, texts, pool, args.samples)
            result.update(cold_load_and_first_recall_ms=cold,
                          steady_state=steady_state, encoding_events=encoding,
                          encoding_steady_state={name: summary([row["elapsed_ms"] for row in events[2:]])
                                                 for name, events in encoding.items()},
                          embedding_inputs_per_call=len(texts) + len(pool))
        else:
            with replace(baseline, embed_texts=lambda values: vectors), replace(current, embed_texts=lambda values: vectors):
                result.update(measure(modules, texts, pool, args.samples, memory=args.mode == "memory"))
        report["results"].append(result)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"mode": args.mode, "pool_size": size, "output": str(args.output)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()

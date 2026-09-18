# 词法召回 MAX_QUERY_CHARS 在分词前截断，长 query 尾部关键词静默归零

Triage: needs-triage
State: open

## 问题

`src/notalone/retrieval/lexical.py:60` 用 `_normalize(query)[:MAX_QUERY_CHARS]` 截断，截断发生在分词之前。待回复消息超过 200 字符（转发长文本等）时，尾部关键词整体落在 200 字之外被丢弃，对相关记忆的召回得分静默为 0。

探针实测（2026-09-18）：query 为 `"嗯"×200 + "徒步"` 时，对记忆"对方喜欢周末徒步"得分为 0.0。

## 影响

回复链路的 query 是待回复消息全文；长消息尾部出现的关键词完全不参与召回，导致相关记忆静默漏召回。

## 为什么测试没抓到

`tests/unit/retrieval/test_lexical.py` 只测短 query 与常量值；`recall_cases.py` 全部用例 query ≤ 20 字符。

## 候选方向（需要设计决策）

1. 截断移到分词之后（先分词再按字符预算截词元）。
2. 首尾双向采样（保留尾部窗口）。
3. 提高上限并记录失败模式到 `docs/memory-recall-evaluation-baseline.md`。

注意 200 是基线文档标定常量，改动需同步评测基线。

## Comments

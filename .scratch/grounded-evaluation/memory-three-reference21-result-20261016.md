# 三票收口的公开21窗基线：第五窗安全停止

按[本次计划](memory-three-completion-plan-20261016.md)，独立新run `13a98a8f-6979-4714-b2f0-d2723244476a` 已实际执行并关闭。当前提示没有通过指代安全门，不据此关闭任何原票。

## 实际结果

原21窗、28必需及1可选、source-fidelity-v2、uniqueness E和legacy四槽V均不变；仅官方DeepSeek。10/42次请求全部HTTP200、零重试，余32永久关闭。A01–A05共5窗完成，A06–A19及B01/B02共16窗未运行，分母保留；不与旧14窗部分结果拼接。

| 范围 | 必需raw | 接受 | 完整契约 | 结果 |
| --- | --- | --- | --- | --- |
| A01–A04 | 5/5 | 5/5 | 5/5 | 4窗safe |
| A05 | 1/1 | 1/1 | 0/1 | 歧义auto1、bad_auto1，安全停止 |
| 全部已运行 | 6/6 | 6/6 | 5/6 | 4safe、1safety_error |

A05原引句完整保留姐姐出借、联系人接收及借用已发生，没有新增产权假事或错人；但实际标签未标物品归属/代词未知，alternatives为空、reason只为通用说明，confidence为原始0.95。最终进入评测理想三门auto，违反冻结的pending要求。V可见字段及原句对应通过，不能替它看不到的E两字段背书。已审E字段68/70，V字段20/20及可见语义5/5；模拟auto2、pending3，无业务采纳。旧matcher独列4pass/1fail（A02字符串/分支差异false_fact1）；它把A05判pass不抵消语义安全失败。

## 封存与退场

freeze字节SHA `3c9410bfa31708503263ae3c38a364f03af2148c2dd493925c8e7bf24d0ea183`。独立Agent在关闭后、任何后继产品源码修改前核93份来源及8项版本一致。60事件连续、payload和磁盘/result摘要一致，5E max/省略工具选择、5V off/强制具名、实际模型和合同全部匹配；五组RAW/FULL共10份received绑定及正式先后顺序、sealed投影与重新评分一致。

只读SQLite使用mode=ro及query_only=1，唯一state closed=1、requests=10、cap42及关闭标记/manifest一致。实际PID和进程组均独立返回ESRCH。launcher返回0，耗时1064.413秒，finish为closed=true、worker_gone=true、close_unknown=false、outer_timed_out=false；records_error/receipt_error为null、cleanup及capture_gaps为空。没有自动后继。

该核验只认证这次已关闭历史的证据一致性。typed_evaluated/credit均false，实际依据source_bound=false、semantic_basis=null，默认空放行表不变。未读真实聊天、启动桌面、写业务库或发送消息；后继私有核心验收按用户另行明确批准的新固定集及新留出执行，不借本场余额。

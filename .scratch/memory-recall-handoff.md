# NotAlone 记忆系统交接

## 当前目标

继续改进 `/Users/local-user/learn/NotAlone` 的记忆系统。上一阶段已经完成一个正确性修复；下一阶段应设计并实现“按当前消息召回相关记忆”，先做可解释的中文词法召回，不直接上向量检索。

## 已完成：修复 self Pending 确认落错作用域

原问题：提取阶段能识别 `self/contact/shared`，但 `MemoryCandidate` 没有持久化主体。`self` 事实进入 Pending 后，人工确认会固定写入联系人 `confirmed_memory`，把“我的事实”错误变成“联系人的事实”。

本次修复：

1. `MemoryCandidate` 新增 `subject`，限定为 `self/contact/shared`。
2. 提取生成 Pending 时保留 `ExtractedFact.subject`。
3. `MemoryService.confirm_candidate()` 读取候选主体并分流：
   - `self` → `OwnerMemory`
   - `contact/shared` → 联系人记忆
4. PostgreSQL Owner 确认路径在同一事务内：
   - 锁定 owner/contact 范围；
   - 重新读取并校验候选；
   - 创建 Owner Memory；
   - 把候选改为 `confirmed`。
5. `owner_memory.source_candidate_id` 用于来源审计和重复确认幂等。
6. API 返回候选 `subject`，确认 self 候选时返回 `level=owner`。
7. macOS Pending UI 显示“关于我 / 关于联系人 / 共同关系”。
8. ADR、当前架构文档、数据库说明和安装脚本已同步。

关键文件：

- `src/notalone/memory/models.py`
- `src/notalone/memory_extraction/adoption.py`
- `src/notalone/application/memory_service.py`
- `src/notalone/persistence/memory_store.py`
- `src/notalone/persistence/owner_memory_store.py`
- `src/notalone/server/app.py`
- `database/migrations/032_memory_candidate_subject.sql`
- `macos_app/Sources/NotAloneAppCore/BackendModels.swift`
- `macos_app/Sources/NotAloneApp/MainWindowView.swift`

## 验证结果

- 最小回归测试修复前连续两次稳定失败，修复后通过。
- 相关 Python 测试：69 个通过。
- 完整 Python 测试：810 个通过，3 个按环境条件跳过。
- Swift：16 个测试通过，App 编译成功。
- 迁移在 `notalone_test` 上重复执行通过。
- 真实 PostgreSQL 整链测试覆盖：self Pending 确认、Owner 落库、Pending 消失、重复确认返回同一条记忆。
- 迁移 032 已应用到本机 `notalone_test` 和 `notalone_dev`。

注意：迁移前已经存在的 Pending 候选无法恢复此前丢失的主体，数据库安全地默认成 `contact`。若发现旧候选正文明显是“关于我”，应丢弃后重新提取或手动录入。

## 工作区注意事项

仓库在开始修复前已经存在用户自己的修改，不能覆盖或回退：

- `.scratch/notalone-website/spec.md`
- `research/tencentdb-agent-memory-context-retrieval.md`
- `.scratch/pragmatic-memory-smoke-test/score_extraction_intent.py`（未跟踪）

本次记忆修复尚未提交 Git。

## 下一阶段：相关记忆召回

当前主要缺陷：

1. `RetrievalReplyContext` 调用记忆检索时没有传 query。
2. 回复生成实际接近固定读取前 20 条联系人记忆，不是真正的相关召回。
3. 当前 query 匹配只是所有 token 必须是正文子串，对无空格中文基本不可用。
4. Contact Memory Index 只是 `category + controlled topic` 的静态目录；`topic_summary` 类似 `preference:work`，不是语义摘要或知识图谱。
5. Owner Memory 已能存取，但尚未进入回复上下文。
6. 只有条数上限，没有字符/token 预算。

关键代码：

- `src/notalone/reply/context.py`
  - 回复路径在 `_search_memories_or_empty(scope=scope)` 中没有传 query。
- `src/notalone/persistence/retrieval.py`
  - `search_confirmed_memories()` 目前只做简单子串 token 过滤。
- `src/notalone/persistence/contact_memory_index.py`
  - 当前目录按受控分类和主题分组。
- `src/notalone/persistence/retrieval.py`
  - 已有 `search_owner_memories()`，但回复路径没有使用。

## 建议范围：召回第一期

先用 `/grill-with-docs` 明确规则，再 `/to-spec`、`/to-tickets`、逐项 `/implement`。第一期建议：

1. 当前待回复消息作为 query。
2. 中文 unigram/bigram，英文按词切分。
3. 对 `text + topic + category` 计算可解释的词法相关性。
4. 加入最低相关性阈值；无命中就不注入记忆。
5. 联系人记忆最多 5 条，并限制总字符数。
6. Owner Memory 使用独立预算和证据类型，不能与联系人记忆混成一个作用域。
7. 排序信号只使用可解释字段：相关性、时效性、置信度、人工确认权重。
8. 保留现有 owner/contact 隔离、来源有效性、revision 快照和生成前后复验。
9. 建立中文改写、无关记忆、跨联系人隔离、过期记忆和预算截断的回归测试。
10. 暂不启用向量检索；ADR-005 要求先用评测证明词法不足。

## 建议的新会话开场提示

```text
请阅读 .scratch/memory-recall-handoff.md，继续 NotAlone 的记忆召回改进。
先使用 /grill-with-docs，把“召回第一期”的产品与技术决策写入现有 CONTEXT/ADR；重点确定 query 构造、中文词法评分、Owner/Contact 双预算、相关性阈值和评测门槛。不要直接实现向量检索，也不要覆盖工作区中已有的用户修改。
```

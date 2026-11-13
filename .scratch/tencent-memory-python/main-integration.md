# 最新主分支整合记录
Triage: ready-for-agent
State: resolved

- 用户要求：将相关分支、工作树代码整合到本地 main，再重新扫描性能。
- main 起点：2ee24ed0；先快进到近期修复 6bf6c2d0。
- 合并来源：codex/tencent-memory-python-implementation，2b9c234f。
- l1、l2、noop、profile、scheduler 已包含于该来源，不重复合并。
- 当前开发实例继续保留在原工作区；整合使用独立工作树，禁止打包及 push。
- 原工作区未提交的架构图删除不属于本次代码整合，保持原状。
- 迁移：保留既有 087；新增持久观察调度使用 088。
- ADR：个人画像 072、前台观察 073 保留；腾讯参考编号调整为 074。
- 语义：兼容批量裁决与本机混合召回，保留自动失败、人工保护和来源删除合同。
- 上层：工具维护与个人推断、逐项隔离及原输入正文限额共同保留。
- 历史真实模型验收不冒充本次整合验收；本次只使用合成数据与隔离测试库。

## 验证
- TypeScript：`npm --prefix desktop run typecheck` 通过。
- 桌面历史/候选编辑/同步恢复：指定三个 Node 测试文件共 12 项通过；开发控制模块 7 项通过。
- 迁移：`tests.integration.persistence.test_database_migrations` 19 项通过，含 087→088 原地升级及旧账本不变。
- L1：相关 156 项单元、17 项真实 HTTP/隔离 PostgreSQL 测试通过；只在外部模型边界返回合成结果。
- 上层：21 项 SDK/个人工具单元及最终 21 项场景/画像工具集成通过；原画像/纠错失败方法适配现行审计合同后复验通过。
- 调度：持久调度 8、观察流 18、验收观察入口 1 项通过；合并使用真实生产装配与随机测试库。
- 更广检查保留缺口：旧 model_priority_lifecycle 15 项中 13 项失败/错误；其中一项在合并前原工作区同样失败，旧协议夹具未认证通过。
- 默认 `npm test` 为 180/182：新工作树无 .env 的文件范围夹具已用无配置合成占位单独复验通过；另一项为既有未知无头租约，未删除未知现场。
- L1 991 项旧运行有 27 个失败子用例；自动结果合同漂移已由 153 项针对性验证收敛，3 项 owned-worker 的 worker.log 缺失尚未扩展修复。
- 本次未运行真实微信切换、未调用外部模型、未连接业务库或执行业务库迁移。

## 审查与剩余交付范围
- Standards：未确认新增硬标准问题；fastembed 未进入独立版运行时锁清单，发布前仍需补齐依赖、许可与运行时验收。本轮不打包。
- Spec：发现新批量/文档解析路径逐项隔离不足，已补回并通过红绿回归；复审关闭。Standards 小范围复审也通过。
- 公开历史检查：合并前 25 处，整合后 26 处本机路径命中（含导入历史）；未重写历史或 push，不代表可以公开发布。

## 合并后性能复扫
- 固定代码基准：`main f17f099a`；七个相关本地工作分支均已证明为 main 祖先，相关工作树无独有未提交代码。
- P1：后台重试退避与新增文档多轮请求都整段持模型许可，宜按物理请求领取并在退避/轮间释放（`application/model_priority.py:232`、`application/organization_call.py:42`）。
- P1：回复仍逐项全量读取再筛 ID，且同一发送边界重复复验，宜按范围和 ID 集合批量读取并统一入口（`reply/context.py:803`、`persistence/retrieval.py:226`）。
- P1：导入追踪仍约 2N 次逐行 SQL，规则文件摘要仍逐条计算，宜批写及批内复用（`persistence/source_processing.py:41`、`source_processing/rule_capture.py:19`）。
- 桌面：输入仍复制完整会话并逐监听者广播，Skill 每三秒固定刷新仍在（`desktop/src/main/reply/session.ts:157/2249`、`renderer/SkillLearningPage.tsx:24`）。
- 新增开销：L1 已为 BM25+本机 embedding RRF；每批重编码旧池，每候选重建词项/频率和范数，宜先批内复用再评估有失效合同的内存缓存（`memory_extraction/recall.py:46`）。
- 新增开销：持久调度每两秒新连接补扫，待处理 receipt 取全量计数且缺匹配待办的部分索引；可评估 COUNT、索引及通知加低频补扫（`persistence/extraction_schedule.py:27/66`）。
- 新增开销：画像同时发送 existing_profile 和 previous_profile 两份同正文，工具循环累积正文；先统一语义字段并测每轮字节（`memory/profile_workspace.py:121`）。
- 已有优化保留：模型加载单例、正文批写、游标分页、持久阈值/空闲恢复、有限工具循环、逐物理请求预算、来源删除及逐项隔离。
- 最新主分支仅导入后端命令模块的一次观察为 1668.5ms，已核对实际加载自整合工作树；不是完整 App 启动或统计基线。
- 上述为代码证据与方案，尚无端到端性能压测或加速比。建议先并行处理模型调度、回复批量复验、桌面状态减量，随后导入和新增检索/调度开销。

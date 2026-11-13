# 03：桌面输入状态减量与非重叠刷新
Triage: ready-for-agent
State: resolved

## What to build
长会话输入减少完整历史状态往返，Skill慢请求能结算且空闲少刷新。

## Blocked by
None (can start immediately)。

## Acceptance criteria
- [x] 输入后立即生成与切换联系人不丢输入，迟到事件不能跨范围恢复。
- [x] 减少输入期间完整历史复制和双窗口无效广播，以合成负载IPC字节/快照次数证明。
- [x] Skill自动GET单轮在途，结算后调度；隐藏暂停、恢复刷新，POST及失败写不自动重放。
- [x] 候选编辑、复制、删除、会话恢复和来源失效行为保留；类型检查及相关React/控制器回归通过。

## Comments
用户已授权此拆分。遵循同目录规格；执行会话独占本任务文件与其责任代码，主会话负责集成和真实桌面。


## Answer
- 输入使用同一联系人范围、连续修订的增量投影；完整权威读取和既有完整响应接口保留。页面轻量写入即时应用，不做输入防抖；回复与依据事件仅发送助手窗口，管理窗口不订阅。
- 主进程依据、表达样本及删除协调按使用字段订阅；候选编辑改为不可变投影。异步联系人恢复通过已有输入清理修订同步草稿框，普通回显不覆盖新按键。
- Skill 自动刷新共享同范围在途读取，结算后调度；活跃任务间隔3秒、空闲15秒，隐藏停排、恢复立即读。未知审核写结果保留给用户显式原操作重试，自动刷新不重放POST。
- 性能接缝：从共同基线0fb6b392与实现代码各构建相同生产控制器/桥接，用固定正文量的10/100/1000轮合成失败历史，各写入20次要求。下表计返回及广播JSON字节，按目标窗口数计费；耗时为本机合成循环，不能外推实机体感。

| 历史轮数 | 基线字节 | 实现字节 | 完整历史广播前→后 | 20次输入循环毫秒前→后 |
| --- | ---: | ---: | ---: | ---: |
| 10 | 886230 | 6270 | 20→0 | 5.52→0.70 |
| 100 | 8305830 | 6270 | 20→0 | 34.68→0.50 |
| 1000 | 82501830 | 6270 | 20→0 | 370.47→0.38 |

- `cd desktop && npm run typecheck`通过；`node --test`运行reply-input-stream、desktop-interaction-view、skill-learning/controller、skill-learning/review、assistant-candidate-version-ports、style-samples/controller、style-samples/candidate-version-source、candidate-copy/controller共280项通过。真实React使用本机已有Chrome无头运行并关闭；最新输入进入生成准备请求后，合成后端有意停止，不调用模型。
- React覆盖立即生成输入、联系人切换恢复和旧事件；控制器/IPC及既有真实JsonClient合成HTTP覆盖候选编辑、复制、迟到、删除与来源失效；Skill页面实等4秒GET完成、隐藏/恢复及失败写不重放。
- `perl -e 'alarm 600; exec @ARGV' -- npm test`：180/182通过。失败为缺失.env资源的Vite状态200/预期403，以及既有无头租约needs-owner-verification；已从共同基线导出到自动清理的临时目录逐例复现相同失败，未修改断言、未清除未知租约。
- `node scripts/check_public_history.mjs --ref main --working-tree`及额外HEAD检查均命中26处既有本机路径；本任务代码、测试与任务文件新增命中0，不改写历史。
- 独立code-review：Standards只有1项非阻断P3提交正文换行格式；后续提交用真实换行，不重写原提交。Spec无发现。
- 数据影响：仅改变本机内存投影、IPC传输与读取调度；来源删除、owner/contact隔离、最新输入和手动发送合同保留。只使用合成数据，无业务库、业务.env、真实聊天、外部模型、数据库迁移或发送动作。
- 真实App、微信及最终桌面验收由主会话独占完成；本会话未启动Electron、打包或push。无App/运行时/原生构建产物留存，临时基线目录自动清理；复用既有Node依赖安装。

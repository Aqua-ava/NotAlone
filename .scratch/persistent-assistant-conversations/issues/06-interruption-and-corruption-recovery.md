# 06：中断损坏及未提交结果安全恢复

Triage: ready-for-agent
State: resolved
Blocked by: 04

规格：[持久助手会话与空闲分段](../spec.md)。

## 交付行为（What to build）

宿主中断、运行文件缺失／损坏／不兼容，以及日志与业务提交不一致时，用户仍能查看正确历史；恢复不自动生成，也不把未保存结果伪装为完成。

## 阻塞关系

- [04：最新背景与旧讨论按需接入](04-fresh-context-and-legacy-history.md)。

## 验收条件

- [x] 真实宿主覆盖正常退出、测试自有进程异常退出和再次启动，不以重建服务实例代替进程恢复。
- [x] 中断轮按业务规则标中断；SDK 补关闭事件不是半步续跑，无用户动作不自动再请求模型。
- [x] 明确重试遵守既有任务和幂等合同，不重复保存候选，不跨会话恢复任务。
- [x] 文件缺失、损坏、格式不兼容或身份不符时不盲目继续出站；可按有效业务历史安全重建，保留原产品讨论身份。
- [x] 日志先成功而 DB 提交失败、完成回执丢失或旧回执迟到，均以数据库裁定完成结果，未提交运行轮不能冒充可引用历史。
- [x] 修复沿用已完成的当前资料核验，不恢复已删或失效材料，不因故障扩大外发范围。
- [x] 修复失败有界、保留输入及可见历史并提供可处理状态，不无限加载或循环创建会话。
- [x] 通过异常退出、磁盘、提交及回执故障屏障验证，测试只控制自有宿主与合成资料。

## 验证入口

复用正常退出重启、公开生成回执及来源隔离夹具，新增测试自有宿主异常退出与有限磁盘／提交故障控制点。

## 执行边界

遵守正式规格；先最小红绿，再相关验证与双轴审查。仅开发热更新，不打包、不发微信、不推送远端。

## Comments

- 2026-10-26：用户已确认后发布，尚未领取或实现。

- 2026-10-27：04双轴PASS并合入d30b2b7d，集成后台61／桌面33、双端类型及公开历史检查通过；总控领取06。独立worktree /Users/local-user/.codex/worktrees/persistent-assistant-06/NotAlone，分支codex/persistent-assistant-06，干净基线d30b2b7d。复用04 readPlan/materialize，迁移从123开始；只读勘察见外部recovery-recon.md。07继续等待06验收合入。

- 2026-10-27：04补查发现正常续用全正文装配P2，依赖验收撤回；按总控指令暂停06推进，保留干净checkpoint a12fea737426cda839d302900befdbdc9292241f（未完成、不可合入）。真实SIGKILL未过期／过期lease红绿1/1，存档及DB回放两例仍红；自有child／夹具已清理，等04修复验收的新基线再merge继续。

- 2026-10-27：04修复fa330双轴复核PASS，合入ed2f30314eed304521c6fe04b5925eac00947d13，集成后台57／桌面33、双端类型和public0；总控恢复06，原checkpoint仍未完成，先merge该基线、透传PlanReader build参数后继续纵向TDD。07继续等待06验收合入。

- 2026-10-27：已merge新基线为158118ae，backend type和定点3例通过（含04资格旧候选0B）。新增真实官方SDK持锁child红：删日志但活锁仍在时旧checkpoint误允重建，正在通过官方create／flush确认原路径锁修复。磁盘拒写单例已绿，保留历史且每次明确resume仅一次尝试；未来格式／身份／权限、未知close占用及空闲分段prepare回执全丢找回仍待验证，不能据此resolved。

- 2026-10-27：恢复矩阵相关后台94／桌面66、双端类型已绿，涵盖真实Host退出／SIGKILL／重启、fsync后DB阻断、DB完成runtime提交失败、档案分类及来源修正。收尾自检发现真实BackendHost停止端口仍限旧SID（早期fixture替身未覆盖），全prepare回执丢失的真实Host+传输替身红绿已过23相关，正常分段回执后的停止同一缺口仍在修。上述为未固定WIP证据，仍claimed，不提前合入或resolved。

- 2026-10-27：固定22d85779624923b7b516c4473d48106c980b05b8，树干净、已merge ed2新基线；相对ed2 14文件+477/-40。最终存档／删除53/53、后台相关94/94、桌面77/77及双types/diff/public0；真实停止端口分段缺口已闭环。总控固定refs和非空diff启动review06_standards／review06_spec独立审查，仍claimed，07仍open，门禁不改。

- 2026-10-27：22d独立Standards PASS（后台5／桌面6），Spec真实Host复现P2：空闲分段全prepare回执丢后删除旧SID成功，new turn仍running，requested_session_id FK被SET NULL；生产恢复因旧SID404返回null且Main忘记旧identity，不能证明实际新任务已结束。未合入／未resolved。原06实现者先只读诊断，待reviewer完成固定22d观察后修复；不以删除旧段自动取消无来源依赖的新段或自动生成消红。证据review06-spec/deleted-alias.test.mjs及deleted-alias-proof.json，07仍open。

- 2026-10-27：P2完整真实Host+BackendHost/RuntimeClient+Main/preload红绿已过：拒删未知受理旧别名时无op/pending fence，原job/new turn保留；明确按原key/input/turn停止后可删旧段，新段保留、模型0。另真实PG COMMIT Promise屏障并发2/2：预检后受理新分段，实际删除owner事务二次守卫令原op failed，alias仍在；找回停止后同op retry成功且无死结。只改本票6文件，无迁移；尚待最后相关验证、新固定SHA与同轴复核，仍claimed。

- 2026-10-27：P2修复固定1eead9dad1a6b7d2d0403b49bcc58c1af6b634f1 clean（基于22d增量7文件+80/-14），后台相关31／最终删除15／桌面40、双端类型和public0；原Standards delta独立2/2 PASS，原Spec同轴复核中，不提前resolved或合入。无新迁移，门禁不改。

## Answer

由22d85779及1eead9da（含暂停checkpoint a12、merge158）实现，固定1ee经Standards／Spec双轴复核PASS，合入ca437b5059cb40b322c40f96ae78462fc6568882，tree与审查HEAD相同且干净。原22d Spec P2与真实红灯保留。真实进程正常退出／SIGKILL重启、fsync先落文件而DB未提交、DB完成但runtime发布失败、HTTP回执丢失均以DB裁定；恢复零模型、明确重试幂等，幽灵结果不进入实际后续请求。缺坏dirty可修存档每次动作至多一次重建，保business SID；未来版本／身份／权限／活锁／close未知拒绝，保留历史及来源／删除围栏。沿04资格inspect／必要build，无新增迁移。

只读generation-receipt及捕获原认证停止端口以精确alias/key/input找回任务；删除前与实际owner事务双层拒删仍承载新段running受理的旧别名，Main保留unknown job和明确stop入口，stop后同op retry可完成且新段保留。真实PG COMMIT屏障证明TOCTOU及无pending死结，未自动取消无旧正文依赖的新段。

集成最小2/2、后台71/71、桌面40/40、双端typecheck、diff和公开历史issues=0；实现者原相关94、最终存档53／桌面77、修复31／最终删除15／桌面40，独立Standards5+6及delta2、Spec6+1+2及delta2+15存在重叠，不相加。证据外部diagnostics/persistent-assistant-20261026的ticket06、review06*.md及integration-06。测试全为自有合成PG/home与loopback供应商，已清理自有资源，无实际App／微信／真实模型、真实批迁、打包或远端操作。正常持久配置仍关闭；07承担正常入口、全量、性能及实际桌面／模型验收。

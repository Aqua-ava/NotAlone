# 11：集成同输入审核与明确范围发布

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 10
Source unit: U10 / S源票10
Migration mapping: S065→066 (canonical)

## 交付行为

用户用同一冻结输入对照旧策略或无Skill与待审草稿，明确编辑、接受、拒绝或暂留并确认范围；只有有效批准的不可变版本进入实际回复。

## 范围与兼容

- 复用S只读对照、版本/范围CAS、恰好一次发布和真实调用台账，追加canonical066；扩展09尚未启用的审核来历。
- 可组合已有上下文端口，若07已交付则完整捕获导航；不为可选字段整文件复制强加07前置。

## 依赖说明

功能前置是09草稿；Blocked by 10是选定canonical065前缀并已传递09，不表示审核产品依赖资料升级。

## 验收标准

- [x] canonical066保留065前缀并引用真实草稿；旧Skill review_origin=false保持，不回填为用户审核来源。
- [x] 新旧对照使用同一冻结输入、预算和真实受控调用，不临时发布试用；编辑/来源/目标版本变化使旧对照与批准失效。
- [x] 接受/编辑/拒绝/暂留及联系人/场景/通用范围明确；原子幂等发布，新版实际用于候选并展示版本/范围。
- [x] prepare/执行/恢复/最终writer均核Skill状态、来源与范围；精确Skill scene从输入到冻结、联系人缓存恢复保持；只有已安装字段可读，新增来历/导航/修订严格版本化。
- [x] 删除清私人依据、对照、策略/资源/方法及广范围跨联系人使用副本；GET前直接核持久擦除，重启旧批准拒绝。
- [x] 公开HTTP/PG、生产React审核、原本地包路径、实际runtime加载与调用台账相关回归和两轴审查完成。

## 验证入口

沿用skill review、review upgrade、Skill探索和草稿审核页面；补与M2固定准备及可选07导航的组合验证。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

首次发布时仅形成任务；当前已按持续实施授权在独立集成树完成本票并签收，状态以上方State及下方记录为准。S分叉库保持原样。完成本票也不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

- 2026-10-16：10固定候选 `b8fc33f0` 经独立Standards／Spec两轴均0未关闭，无冲突合入 `16be9841` 并签收 `2887c42a` 后，按真实依赖领取本票。在独立11树接续canonical065，先验证审核的实际SDK请求、输入预算编码与逐次调用台账，再追加066并完成只读对照、明确范围发布及删除闭包；六项AC仍未勾。保持M2固定准备、联系人场景恢复、未知预算本地拒绝与原本地包路径，不提前查询067／068。S库保留、不合main及不动其他会话边界继续有效。

## Answer

票11候选已在基线 `b7425f663aa0bcaf2d94bfa6c86afc0e5b281120` 上集成同输入对照、明确范围双确认原子发布、scene贯通、实际版本加载及删除闭包，经独立Standards／Spec完整及增量审查后已签收，六项AC完成。来源包含`eaa8859f`自身三路径请求合同以及`eaa8859f→aac75f16`，canonical066保留原S065字节，001–065及M2/035不变。

首版候选`5bb5bdf1436a09d4f3323f1d2392b98bfdff629b`的PG/HTTP共112唯一方法有绿证据（14轮197次执行，含原red/error）；canonical066前向/全量/重复0，旧review_origin=false不回填。公开审核23唯一、本地包56、准备/最终writer21、学习/偏好9及迁移3；Python unit1460、Node175、安全65均过。该版单Chrome审核页1/1，learning1＋reply9/外部0，17个自有库（含页面）均核DROP与absence；真实App/微信留后续15。

普通reply/探索/审核共享实例在构造时显式零SDK重试，公共provider默认2保留；DeepSeek ToolStrategy明确thinking disabled，DTO与实际body同值，已批准ECNU配置不加thinking、未知DeepSeek预算仍本地拒绝。SDK首批31次允许且已核算的Mock请求＋1次cap拒绝入口（总cap32）关账，其中28份保存原body/DTO，另独立3次只存原工具输出；最终13和全unit独立新批审核13均body==DTO，真实外部0，不代表整套unit SDK总数或模型质量。

原失败、精确恢复分轮与边界详见[11集成记录](../frontier-11-validation.md)。关键新red是prepare尚无reply_request时跨联系人准备副本未物理擦除，沿真实Skill版本选定原A删除根后绿；保留两个固定未知故障库在连接前被guard拒绝、poison导致teardown错误，以及实例slots patch误用的原日志，未连接/清理未知库、未放宽guard。首版页面实际276模块原字节封存，275与首版相同，唯一测试模块后增偏好单例，移除新增method后AST精确相同。未包含未来067／068、方法政策、真实模型、业务库、push/PR或main合入。

独立审查增量修复两个P2：删除受影响审核版本的description，并只在该版本为current时清目录摘要；按008既有非空约束使用固定无正文占位“来源已删除”，独立包及不受影响新版保持。catalog、资源许可和最终writer仅投影元数据，显式load_version才读策略正文，来源/范围WHERE不变；抽取现有connection内的比较状态核验，锁序与租约语义不变。15只读预检发现的`342e63a8`两文件最小修复前置归11：候选历史只读投影未物化原版，编辑/选择仍真实写入；删除接受未物化合法原版并继续精确核已有版本身份，未导入未来组合框架。

新有限轮保留摘要残留、正文投影、只读加载三项真实red及工具/清理故障。最终HTTP35/35、投影/删除链23/23，增强首GET前SQL三例另3/3；增量10轮69次、58唯一方法均有绿证据，与首版method ID并集139。12个新增自有库均精确DROP/absence，另独立复核被poison轮的两个已知库不存在。旧SDK额度保持关账，外部调用0。最终逐文件对照原页面为270/276字节相同，变化为四个产品及两个测试模块；本增量未重跑页面或整suite，旧页面与unit成绩仅归属首版，新相关闭包和原字节另封存，已通过两轴独立增量复查。

独立Standards原P2目录过读正文及P3重复核验、Spec原P2来源删除摘要残留均已关闭，最终未关闭及新增均0；两轴报告只读固定Git与既存证据，未独立重跑动态验证。最终候选 `bd7d568200e2d8ad289ee9ff6caf5e7e6e620e6b` 的98文件manifest、Git blob和保存原字节逐项核对一致，无冲突no-ff合入 `ce4c1151bb439759414b6deb938ed6591e92cd85`，merge tree与候选完全相同。

merger实际仅执行 `npm --prefix desktop run typecheck`、工作树／暂存／base／M2的 `git diff --check` 及Node标准库静态核验：001–066连续，001–065与基线、001–058及035与M2逐字节相同，066与S065原字节相同；选用审核夹具严格66／末尾066／重复0，旧053／058／061／063／064／065 setup不机械改号。codec2/schema4、权威input重建scene、500条／三处SQL范围门／3-16-2048预算及三处Grounded默认保持，未来067／068表查询0。初版临时断言误把scene读取写成payload.get，实码为canonical content.pop；修正检查后通过，不计产品红绿。一次只读检索遇到不存在glob为工具错误。合并后公开历史检查main（只读56051719ffa8881e53daf1040208b05aeea61087）及HEAD均issues0，签收提交后再核。

原112唯一PG／HTTP与修复58唯一的method ID并集139，分别14轮197次及10轮69次执行，不称单轮139/139。HTTP35/35、投影/删除链23/23、增强首GET前3/3各自独立；3例未新增resource直接SQL断言。原17加修复12共29个确证created已精确DROP／absence，仅核本票已知资源。原误标readonly-green重复红、recovery-green两功能通过加一teardown error及postpoison两own ID absence继续保留；不改写全绿。最终270/276页面模块相同，旧unit1460／Node175／safe65／页面1/1仅归首版5bb，修复后未重跑suite或页面。实际App／微信、真实模型及业务升级未验，默认质量门与DSH未放开。03默认库事故152方法／65错误／1跳过的实际库及影响unknown，旧35目录DB UUID0、07／08旧各四嵌套UUIDunknown继续未关闭；未知库未连接、扫描或清理，不声称其他会话无影响。

六项AC及Answer齐全后标为resolved；当前12 resolved（01–11、14）、0 claimed、3 open（12／13／15），AC71已勾／20未勾。12仅逻辑就绪仍open，未领取。本票完成不等于持续目标完成；S库保留，不合main、不push／PR或部署。

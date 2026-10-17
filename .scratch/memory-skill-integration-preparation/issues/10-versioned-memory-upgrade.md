# 10：集成版本化Grounded资料比较与批次应用

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 09
Source unit: U13 / S源票13
Migration mapping: S064→065 (canonical)

## 交付行为

用户选择资料范围与总预算后，先查看版本化Grounded产生的新旧差异，再明确应用或撤销仍合法批次；已有人工决定和旧未知证明保持。

## 范围与兼容

- 复用S升级应用/持久化/trace/世代与进度，追加canonical065；默认算法改为已确认的版本化Grounded及事件适配。
- 独立于07导航和后续审核政策；预览可保存job/batch/task/preview/trace，但不写权威记忆或推进提取水位。

## 依赖说明

09提供task复合父键及064前缀，01/02/03业务基础已传递；不等待07/11/12/13。

## 验收标准

- [x] canonical065承接064的task复合父键/步骤和trace关系；新合成库验证前向/全量/重复，不访问S库。
- [x] 明确范围、总调用/数量预算、预览差异和批次批准可操作，预算在真实调用边界扣记，取消/部分失败/重启状态准确。
- [x] 使用集成后的Grounded默认和有来源事件适配；算法/协议指纹绑定预览与批准，变化或旧指纹拒绝，不声称旧提取器比较等于新算法升级。
- [x] 预览不改权威事实和水位；实际应用分别覆盖合法新增与人工保护空动作，旧NULL/版本一依据不补成新证明。
- [x] 来源/资料修订/人工决定变化拒旧批准；同键幂等、新键旧修订冲突，undo仅撤本批仍一致的自动写入，不覆盖后续人工决定。
- [x] 接续02后置的升级擦除hook并纳入原删除事务；GET前直接核比较/提取/批准/trace副本已删，重装配旧apply不可复活；保留原间歇超时失败与恢复，完成相关HTTP/React/Worker回归及审查。

## 验证入口

沿用memory upgrade/batches/lineage/worker及迁移组，补Grounded默认、算法指纹和新增/空动作两条链；保持原超时阈值与失败分母。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

用户已追加实施授权；本票在独立集成分支完成工程签收，实际App／微信及真实模型质量仍由后续整体验收分列。S分叉库保持原样，签收不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

- 2026-10-16：09最终候选 `6370c06b` 的独立两轴复审均0未关闭，经merger合入并签收 `1ea12db5` 后，按真实依赖领取本票。在独立工作树接续canonical064，先以实际SDK本地Mock验证请求合同及有限重试，再推进Grounded持久指纹、公开HTTP与追加065；尚无本票功能签收，六项AC保持未勾。S分叉库保留，不合main、不执行业务迁移或远端操作。

- 2026-10-16：固定候选 `b8fc33f03d7c93b10f9960caa0d650aca2cae355` 经独立Standards硬项0／possible0及Spec三类发现均0后，无冲突no-ff合入 `16be9841e92cf3559f0f470cad8a7cd8d9f121fb`，合并树与候选完全一致。独立merger最小类型／静态合同及publication检查通过，六项AC签收，本票resolved。11仅逻辑就绪仍open；分轮证据与原失败见[10集成记录](../frontier-10-validation.md)，没有新数据库、模型、页面或App运行。

## Answer

在领取基线 `61e34a40` 上选择性承接 `7af7e083`／`4b28f4c3` 的升级模块，未整搬含后续审核／政策的差异。
canonical065承接冻结S064及09的task复合父键、步骤和trace关系；001–064逐字未改，前58份另与冻结M2逐字核对。
S064 SHA256为 `5ebcea6b8e7800f652b6b7a01ad51d1da730f4cbaae8d882792aef16bad9ddbb`，
本地065为 `591f5831dcb65ec2ef03a52b040084876577aa3d87f84edee4e9c944ff21b916`。
两处可空algorithm JSONB及其约束／注释、algorithm_changed分类是明确的本地delta，不宣称与S原字节相同。

已接入明确范围／总预算、Grounded原文标签编译、独立V及按需A、新旧比较、逐批批准、取消／恢复／幂等和仍合法自动写入的undo。
预览只保存工作／批次／比较／可删除追踪，不写权威候选、记忆或提取水位。
默认维度放行表仍为空；自动新增／update与undo的事务测试仅在明确synthetic门配置下进行，不代表真实质量放行。
人工决定保护、旧NULL／版本一证明未知及完整来源世代保持，当前Flow不会为旧依据补造新证明。

工作与批次持久绑定当前grounded-labels-v3／grounded-source-event-v1、V模式、实际规则与writer依赖摘要、SDK版本和非秘密有效配置。
准备、批准、领取／预扣预算、保存及最终正式writer均复验，实际写入后身份变动也在同一事务回滚；旧NULL身份可回看但不补签或应用。
配置读取实际模型名与无凭据端点；userinfo／query／fragment端点拒绝，API key与请求头不进入身份。
升级专用SDK max_retries=0，其他入口默认2不变；thinking下升级V省略具名tool_choice，仍严格解析唯一指定工具，A同时拒绝错名／多工具／额外字段。
预算沿许可后、调用前保守预扣；发送前追踪或本地失败不退回预算，真实外发另记无正文台账。

02后置hook已接入来源、资料、联系人原删除事务，直接擦除comparison／extracted_outcome／adjudications／applied_records及完整trace副本；HTTP测试在下一次GET之前直接SQL核验。
来源变化、人工改动、取消、失败／租约恢复、部分成功与旧apply重装配都不能恢复已擦除结果。
当前仅依赖001–065，不查询未来066–068审核或政策表。Main／preload／React显示旧人工事实、未知证明、算法身份与明确预算，删除未决时隔离旧比较。

验证按实际轮次记录，原失败日志全部端侧保留：

- SDK最初2方法均失败：固定500实际派发3次、V具名请求1次，合计4次本地Mock；修复后2/2。A严格解析另1方法3子例red后通过。最终SDK7＋身份2＋实验AST1共10/10（0.365秒），实际SDK派发4次、外部0；本地bind失败断言invoke／HTTP／ledger均0。实际模型名另有0HTTP红例，helper只改展示名的旧反例随后改为实际模型名并2/2恢复。凭据端点／头字段反例0HTTP。
- 升级unit先42中37过5error，18方法窄恢复覆盖该5项；完整unit先1450中1448过、1fail／1error（条件AST与本地bind台账场景），9方法窄恢复后补实际bind零调用及秘密排除反例，最终单轮1452/1452（12.959秒）。实验AST明确核具名与省略两分支，未知形状仍拒绝；真实invoke失败仍记失败台账。
- 私有driver守卫先29/29纯fake。首prefix1/1、首Core1/1、首4指纹HTTP4/4，各cap1且各1created精确absent；完整升级4Core＋前向迁移组单轮27/27（71.865秒），5created／cap5全absent。
- 邻接首轮8方法通过后Self setUpClass因私有守卫父子继承包装错误而ERROR，2created／cap7全absent。旧41b482原字节及无PG同形red保留；先捕获各类原始bound setup后守卫31/31，含setup异常poison／failfast与known cleanup。只恢复未跑的5类，106/106（386.329秒），5created／cap5全absent；合计114个唯一邻接方法是分阶段结果。
- 最后全量065／重复0单方法1/1（0.588秒），1created／cap1全absent。补端点、实际模型名及规则依赖闭包后，针对最终字节另跑4指纹HTTP4/4（5.514秒），1created／cap1全absent；没有把早期27称为新字节重跑。上述唯一PG／HTTP方法共142，重叠窄组不重复计数。
- TypeScript通过；升级Node19/19，npm test单轮65/65（24.768秒），随后页面runner变更相关Node29/29（3.162秒）。普通npm test只编译／签名仓库探针源码，不执行App、微信或探针二进制。桌面worker早期校验红例、无DB探针PYTHONPATH错误及7中5过2失败后7/7、追加两次真实preview后8/8的原分母均见私有索引。

真实页面为两轮同一case，不能合称首轮通过。第一轮在ready前失败，0 completed scenario、cleanupConfirmed=false；driver无拒绝，1created／cap1已精确absent，Python exit1。
原通道ignore stderr，没有完整原栈，不能事后补称已捕获。静态识别ready所需3个懒模块尚未导入，且proof缺失可用FileNotFound覆盖原错误；夹具改为显式导入稍后会用的模块、私有原栈落盘及缺proof仍保持原异常。
原adapter／driver／实际hook先18/18纯fake，修正后24/24，覆盖ExitStack先close、0600/O_EXCL/NOFOLLOW/fsync、原异常同一对象与因果链保留。
首轮6个runtime PID加outer runner共7 PID及3个登记PGID后置均不存在，无信号；原租约ID／inode／SHA、fixture与执行字节保存后，仅退场本轮已确认自有lease／临时目录，不追改原cleanupConfirmed。

恢复轮用全新目录和额度：`npm run test:pages -- --case memory-upgrade --timeout-seconds 240`，单Chrome的1 case／1 scenario通过。
实际生产Main／preload／React与隔离HTTP／PG覆盖预算→比较→批准→轮询→同库后端恢复→undo→来源删除；默认pending与旧人工记录保持。
started=seen=4／硬cap4、external_model_calls=0；28关键Python模块／270实际模块路径及SHA、exact001–065／repeat0、导入前双URL与独立Core planned、1created／cap1的DROP／absence均记录。
Python child exit0、cleanupConfirmed=true；2个执行artifact及8次浏览器响应原字节（4唯一资产）SHA复核一致。
13个登记runtime PID及已知PGID后置均不存在，App／headless双lease复查absent；没有依据finally推定退场。

端侧原始日志、固定守卫各版、完整分母、迁移delta、实际模块SHA和逐库planned→created→DROP／absence见 `/tmp/notalone10-validation-resource-index.json`。
首页面原字节在 `/private/tmp/notalone10-page-first-JZ3Naq`，恢复轮在 `/private/tmp/notalone10-page-recovery-pZ3Vm4`。
上述实施Answer提交于候选 `b8fc33f0` 时，本票仍claimed、AC未勾；随后独立两轴审查均0未关闭并由独立merger合入，当前已resolved、六项AC已勾。未迁移业务库／S库，未合main、push／PR或操作其他会话工作树；03默认库、旧35／07／08未知资源缺口未连接或清理。
真实DeepSeek、原生App／微信与质量资格未在本票验证，由后续整体验收安排；页面不替代这些结果。

独立merger在clean根 `61e34a40` 核对祖先与97文件非空增量后，以 `16be9841` 合入，树 `b0def78011864ebb2e65973d8092c25eccd65edd` 与候选相同。实际仅运行TypeScript、工作树／暂存／固定base／M2的diff检查及Node本地断言：001–065连续，旧64与根、旧58及035与M2原字节一致，065的两算法JSONB与分类／注释delta精确，task／trace复合外键保留；12组选用迁移门与054–065尾序、原053／063／064前缀setup、codec2/schema4、500／三SQL／3-16-2048及三处Grounded保持，未查询未来066–068表。28个页面实际关键模块SHA与合并候选一致；本次仅核既存索引，不新增动态成绩或资源核销。合并后publication main（只读 `f2a6aca7f1ea31a86b88044aee711358f4611429`）及HEAD均issues0，签收提交后再核。详情见[10集成记录](../frontier-10-validation.md)。

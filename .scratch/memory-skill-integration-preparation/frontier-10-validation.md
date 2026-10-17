# 10版本化Grounded资料升级集成验证

日期：2026-10-16。固定M2 `08c4d48e719353492f37620f4fb2aabd8710efc6` 与来源S `54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616` 不变。本记录签收正式10，实施细节见[10 Answer](issues/10-versioned-memory-upgrade.md#answer)，当前状态见[任务索引](planning.md)。本票工程签收与真实质量、实际App／微信分别计证。

## 来源、审查与合并

领取基线 `61e34a40e79fa4cc092e038a5ee9fdd3ce1d6818`，选择性承接 `7af7e083`／`4b28f4c3` 的升级模块，不提前带入后续审核／政策。最终候选 `b8fc33f03d7c93b10f9960caa0d650aca2cae355` 包含97文件、6130新增／93删除。两端工作树再次核对clean、真实祖先及非空差异后，独立merger无冲突no-ff合入 `16be9841e92cf3559f0f470cad8a7cd8d9f121fb`；合并树 `b0def78011864ebb2e65973d8092c25eccd65edd` 与候选完全一致。

| 独立审查轴 | 固定范围及结果 |
| --- | --- |
| Standards | 61e34a40至b8fc33f0，仓库规范和完整12项Fowler基线；硬项0／possible0。已核278个保存文件及28个实际关键模块SHA |
| Spec | 同一固定范围，正式spec及本票六项AC；缺失／部分实现0、未要求扩展0、看似实现但错误0 |

两轴仅只读审查既有代码和证据，没有另启资源。报告为端侧 `/tmp/notalone-review10-standards.md`、`/tmp/notalone-review10-spec.md`。merger只核必要索引与固定Git合同，没有重做278文件验证或资源观测。

canonical065 SHA256为 `591f5831dcb65ec2ef03a52b040084876577aa3d87f84edee4e9c944ff21b916`，不同于S064的 `5ebcea6b8e7800f652b6b7a01ad51d1da730f4cbaae8d882792aef16bad9ddbb`。本地明确增加job／batch可空algorithm JSONB、version／digest约束及注释，并加入algorithm_changed分类；删除这组精确delta后与S原字节一致。旧001–064与领取根、001–058及035与M2原字节一致，不改loader或S分叉账本。

## 交付合同

- 明确范围与总消息／调用预算，Grounded原文标签编译、独立V及按需A，新旧比较、逐批批准、取消／恢复、动作幂等和合法undo接通公开HTTP及Main／preload／React。预览不写权威事实或提取水位，默认质量维度表仍为空；合法新增／update／undo测试只在显式synthetic门配置下运行。
- 工作及批次持久绑定实际Grounded／事件协议、V模式、规则与writer依赖摘要、SDK版本及非秘密生效配置。准备、批准、领取、预扣、保存和最终writer前后复验，实际写入后身份变化也在同一事务回滚。旧NULL不补签，人工决定及版本一未知证明保持。
- 升级SDK零重试，其他入口默认2不变；thinking模式的V省略强制具名tool_choice，但唯一工具及严格结果解析保持。实际SDK模型名进入身份，含userinfo／query／fragment的端点拒绝，密钥和请求头不进入摘要。预算在许可后、调用前保守预扣，发送前失败不退额度，真实外发另有最小台账。
- 02后置hook进入原来源、资料及联系人删除事务，GET之前直接SQL核对比较、提取、裁决、应用回执和全部trace副本清除。来源世代、人工修订、同键／新键、部分失败、租约恢复及重装配不复活旧结果；undo不覆盖后续人工决定。仅查询001–065，不提前查询066–068审核、版本或政策表。

## 分轮验证与原失败

下表属于实施者固定运行，merger没有重跑动态组。范围重叠时不相加，也不把早期通过转称最终字节重跑。

| 实际轮次 | 结果及边界 |
| --- | --- |
| SDK请求合同 | 最初2方法均失败，500重试2实际3派发加V具名请求1派发，共4次本地Mock；随后2/2。A严格解析1方法3子例red后恢复。最终SDK7＋身份2＋AST1为10/10、0.365秒，实际4次Mock派发、外部0；本地bind失败invoke／HTTP／ledger均0，真实invoke失败仍记失败台账。实际模型名和秘密排除的0HTTP原失败／恢复分别保留 |
| 单元 | 相关42先37过5error，窄18恢复；完整1450先1448过1fail／1error，9方法窄恢复后补真实bind和秘密反例，最终单轮1452/1452、12.959秒。原AST与本地bind台账失败日志保留，不将窄恢复冒称原轮全过 |
| 守卫与最小PG／HTTP | 私有守卫29/29纯fake；prefix1、Core1及指纹4各自cap1／created1精确absent。升级4 Core加真实064→065前向组单轮27/27、71.865秒，5created／cap5全absent |
| 邻接恢复 | 首轮8个方法通过后Self setUpClass因私有父子包装错误而ERROR，2created／cap7全absent；不是9个方法。旧41b482字节、无PG同形red保留；守卫修正后31/31。只恢复未跑的5类106/106、386.329秒，5created／cap5全absent；114唯一方法为首8加后106的分阶段并集 |
| 最终迁移与指纹 | 全量065及重复0单方法1/1、0.588秒，1created／cap1全absent。实际模型名、端点及规则闭包变化后，最终字节指纹HTTP另4/4、5.514秒，1created／cap1全absent。该4方法与升级27重叠，不另加唯一数，也不把旧27称为最终字节重跑 |
| 桌面 | TypeScript通过；升级Node19/19，完整npm test单轮65/65、24.768秒，随后页面runner相关Node29/29、3.162秒分列。npm包含探针源码编译／签名，不执行探针、App或微信二进制。早期桌面校验red、PYTHONPATH错误、7中5过2失败后7/7及补真实preview后8/8均保留 |
| 页面收尾守卫 | 原adapter／driver／hook先18/18纯fake，修正后24/24，核ExitStack先close、0600／O_EXCL／NOFOLLOW／fsync及原异常对象与因果链保留；不作为PG或App成绩 |

唯一PG／HTTP为升级27＋邻接114＋全量迁移1＝142个方法的分阶段并集，重叠prefix／Core／指纹窄组不再加数。八个守卫轮17个确证created，加两页面轮各1库，共19个确证created均有逐名DROP／精确absence。此保护仅覆盖本轮封闭调用路径，不保证任意未来客户端自动受保护。

## 两轮页面与资源

首页面在ready前失败，completed scenario为0、cleanupConfirmed=false、Python exit1。driver无拒绝，1created／cap1精确absent。原stderr通道为ignore，完整原栈没有捕获，不能事后补称已记录；静态识别3个稍后使用的懒模块尚未导入，且缺proof读取可能以FileNotFound覆盖原异常。修正为显式导入、私有原栈落盘及缺proof时保留原异常。首页面6个runtime PID加runner共7 PID及3个登记PGID后置均不存在，信号0；固定归属、字节及租约身份保存后只退场本轮已知资源，不追改原cleanupConfirmed=false。

恢复使用全新目录和额度：`npm run test:pages -- --case memory-upgrade --timeout-seconds 240`，单Chrome的1 case／1 scenario通过。真实生产Main／preload／React与隔离HTTP／PG覆盖预算→比较→批准→轮询→同库后端重建→undo→来源删除，保留默认pending及旧人工记录。started＝seen＝4／硬cap4、external_model_calls＝0，exact001–065／repeat0，导入前双URL与独立Core planned、1created／cap1的DROP／absence均记录。

恢复轮28个关键Python模块与270个实际模块的路径／SHA、2个执行artifact及8次浏览器响应原字节（4唯一资产）均保存；28关键模块与最终候选字节一致。Python child exit0、cleanupConfirmed=true，13个登记runtime PID及已知PGID后置不存在，App／headless双lease复查absent。页面不是实际App／微信，也不认证真实DeepSeek或语义质量。

端侧总索引 `/tmp/notalone10-validation-resource-index.json` 的SHA256为 `6eccf4b5d616a8646fa4541d2d134ad70f5ffe8f841e2b91b4c636a0c8500f49`，278个原字节保存于 `/private/tmp/notalone10-delivery-zs6c7l1z`。最终关键模块、迁移字节及delta分别索引于 `/tmp/notalone10-final-critical-module-proof.json`、`/tmp/notalone10-migration-byte-proof.json`、`/tmp/notalone10-canonical065-local-delta.diff`；首次与恢复页面目录为 `/private/tmp/notalone10-page-first-JZ3Naq`、`/private/tmp/notalone10-page-recovery-pZ3Vm4`。各轮守卫原字节和原失败不被后续脚本覆盖。

[03默认库事故](reports/test-database-isolation-incident.md)的152项／65错误／1跳过及实际库身份／影响未知、[35个旧目录](reports/fixture-ownership-evidence-gap.md)归属已恢复但旧DB UUID仍0，以及[07／08嵌套CREATE](reports/nested-database-ownership-followups.md)各四个未知UUID继续未关闭；新19库核销不补这些历史缺口。没有连接、扫描、接管或清理未知库，不宣称其他会话全程无影响。

## merger最小核验与签收

merger实际运行 `npm run typecheck`、工作树／暂存／61e34a40至HEAD／M2至HEAD的 `git diff --check`，以及Node标准库固定Git和必要已存索引断言，全部通过。001–065连续、旧64与根和旧58／035与M2原字节、065本地delta及task／trace复合FK；12组选用迁移门和054–065尾序、旧053／063／064前缀setup保留。codec2/schema4八类型、500历史ID／三SQL范围／3-16-2048预算和三Grounded默认保持，十个保护合同源码与领取根逐字相同；未来066–068九张表查询0。本次无PG、HTTP、模型、页面、App、微信、探针或租约运行，没有新增动态成绩或资源核销。

合并后以 `NOTALONE_PUBLICATION_ENV_FILE=/dev/null node scripts/check_public_history.mjs --ref main --working-tree` 及 `--ref HEAD --working-tree` 运行本地公开检查，两次issues0。两次前后main均只读观察 `f2a6aca7f1ea31a86b88044aee711358f4611429`，未吸收漂移；签收文档提交后再运行同样两项检查。私有merger脚本／日志／改动文件SHA及完整merge／signoff身份索引为 `/private/tmp/notalone-merge10-delivery-index.json`，本次日志目录 `/private/tmp/notalone-merge10-OzcwUR`。

本票数据影响为显式选择范围的升级工作、比较、可删除追踪和用户批准的合法自动写入／撤销，不迁移业务库。六项AC已勾，当前11 resolved（01–10、14）、0 claimed、4 open，65项AC已勾／26未勾；11仅逻辑就绪仍open，源冻结issue-index.tsv未改。默认质量门不放开，真实DeepSeek、实际App／微信及最终组合仍待15；S分叉库保留，不合main、不push／PR或部署，持续目标尚未完成。

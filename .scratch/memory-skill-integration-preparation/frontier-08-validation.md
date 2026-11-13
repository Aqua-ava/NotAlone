# 08明确长期表达偏好集成验证

日期：2026-10-16。固定M2 `08c4d48e719353492f37620f4fb2aabd8710efc6`、来源S `54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616` 不变。本记录签收正式08，逐轮事实与私有证据指针见[08 Answer](issues/08-expression-preferences.md#answer)。当前进度见[任务索引](planning.md)，普通页面通过不认证实际App、微信或真实模型质量。

## 来源、审查与合并

来源为固定 `b4429b5c→562f85e4`；canonical063与源S062的Git blob同为 `378338ba83aa257aa2cc52367b721d87226c42d0`。07先签收后，08在独立分树按双方语义解决七处接缝，codec version2／schema_revision4同时容纳导航与偏好两种结构，未覆盖07的历史／当前隔离或预算。

| 独立审查轴 | 原发现与修正 | 最终结果 |
| --- | --- | --- |
| Spec | P2为偏好修订漂移后首次无候选仍重投旧键；接入原可靠终态、身份核验和显式重新准备合同，并补生产Main／HTTP及实际React页面反例 | 原P2关闭，未关闭0 |
| Standards | 无硬项，possible P3为HTTP与页面重复维护九项摘要清单；提取显式接收根目录和夹具入口的纯装配函数 | 原P3关闭，hard0／possible0 |

完整审查固定 `0f6f3635→54d77bdd`，接缝复审至 `b536503d`，最后窄审 `b536503d→a1aced022104241057ff9fa0c262fd8a7701b99c`；两轴最后均0未关闭。审查者只读核对既有运行和摘要，没有重新启动业务资源。独立merger在clean根 `36bef1b0` 无冲突no-ff合入 `3e903976cf0808f888c34f6c54dbc6973fb1c34f`，其树与a1ac完全一致。

合并最小检查随后发现偏好值对象文件EOF有多余空行，M2至HEAD的diff检查失败。08实现者仅删除两条空行，提交 `ec1e09512390f69c0b4889b5757632d560e42f1c`；merger独立核对精确两字节换行差及带位置AST完全相同后，无冲突no-ff合入 `df209de1e91de2572b6a5705c14d44d0cef90b3a`，树与ec1e完全一致。原页面仍属于8271／a1ac固定身份；该单一模块的新字节没有重跑，不能宣称原252份加载SHA全部匹配最终树。除这项EOF静态校准，产品、测试和架构与已审a1ac相同。

## 交付合同

- 只有明确长期保存／修改操作写偏好，可查看、修改和删除；普通指令、当前策略、选择复制或保存样本不静默转为偏好。owner、联系人与输入模式范围明确，当前明确意图优先，回执记录实际使用修订。
- prepare在同owner锁和turn CAS内复验偏好，并登记偏好UUID、origin及全部source UUID；尚无reply_request也能在删除事务直接擦除固定JSON与恢复输入。偏好、样本、候选和原来源删除闭包及late writer拒绝均接通，不依赖先GET。
- A→B→A、隐藏缓存和删除未决状态保留独立草稿；偏好变更后的旧快照被拒时先保持作业归属，只有明确操作且旧任务可靠终态／身份核验成功才封旧键并新prepare。运行中、未知终态和读取故障不自动生成新任务。
- 两种非空冻结结构由生产prepare实际装配并往返，schema3明确要求重新准备、保留输入；冻结500条历史ID、初始消息并集、三个SQL白名单和共享3次／16条／2048估算token保持。三处生产Grounded默认及语义质量关闭门保持。
- 精确Skill scene由11接续、范围政策由13接续，本票不提前引入后续表或宣称该范围已验。

## 分轮验证与原失败

各轮范围有重叠，不能混加为一次全量或唯一用例数。全部资料为合成数据，模型为受控脚本，外部模型尝试0。

| 实际轮次 | 结果与限制 |
| --- | --- |
| 原明确动作与迁移组 | 首条目录404后1/1；偏好首轮22中21过1编码失败，修复后偏好24＋真实001–062→063升级1，共25/25 |
| 原相关后端组 | 94＝86过、7失败、1错误；四个嵌套CREATE身份未持久记录，不能认证其退场 |
| 原有限恢复 | 18＝15过、3次CREATE前超长名称拒绝；旧名实际69字，缩短后56字，不计三项为业务通过 |
| 新封闭守卫组 | 无DB模拟后小批4/4、5个具名库；封闭8模块121/121、119.901秒、8个具名库，均逐名absence及记录PID退场；不补旧四UUID |
| 原Node／HTTP | 23/23、16.024秒，9个独立具名HTTP夹具；严格63／重复0、实际摘要、退出0和各自退场分别有证据 |
| 原固定页面 | `a1e819c3`，1 case／1 scenario、1Chrome、240秒上限、脚本2次；属于当时schema3固定代码，不能挪为组合schema4新成绩 |
| 显式重新准备修复 | 纯组40/40；一个真实HTTP反例首轮末断言失败，明确重读保存讨论后另轮1/1。一次误含HTTP文件的纯组为19绿1个Conda门拒绝，建库前终止 |
| 07／08联合HTTP | 首轮failfast实际2项＝1过1失败（遗漏明确requirement_changes确认）；补夹具协议后5/5、20.597秒。每轮独立cap1、1库，未放宽产品 |
| 最新单位及纯组 | 合并后unit1353/1353、12.847秒；偏好／准备40/40，概览14/14，类型检查通过；纯组未启业务资源 |
| 新实际React页面 | 固定 `8271b29492950fbf650805c25856eb5db33f6236`，至a1ac仅Answer变化；单轮1 case／1 scenario通过、1Chrome、240秒上限、1库；脚本入口／返回各3、硬限4、外部0 |

新页面在首个无候选prepare后有限暂停实际模型适配入口，生产UI修改偏好至revision2，再释放旧结果。页面核对草稿保留、旧失败键唯一、模型入口仍1及明确重新准备按钮；点击后才出现新键、revision2候选和实际回执。gate为60秒上限，内层及最外层finally释放；既有意图、范围、后端重启及删除流程继续完成，没有产品测试钩子。

最新页面runtime直接记录schema4、63个迁移名／repeat0、实际模块及计数、请求键／状态／修订、两份事前planned marker；父证据直接记录child退出0及执行产物／浏览器响应字节摘要。页面与UI断言通过取原日志；精确库absence、16个已登记PID不存在及双租约absent来自随后独立观察。原252份加载模块SHA、2产物及4浏览器响应由独立审查核对到8271／a1ac运行身份；EOF校准的单模块字节差单列，未重写旧proof。私有索引为 `/tmp/notalone08-proof-index.json` 和 `/tmp/notalone08-page-review-runtime-index.json`。

## 资源边界与合并最小复验

原94组的session-delete类库1个与lifecycle方法库3个，四个旧UUID未恢复；无finally错误不等于逐名退场。新守卫轮的成功不能替旧轮补证。联合5方法守卫经无DB模拟，cap1／failfast，未知DDL、query、实例或ownership拒绝后poison latch禁止后续CREATE，只允许本轮确证created的精确DROP；仅认证所选Connection.execute／psycopg.connect路径，不扩大为未来Cursor／Async等路径保证。

[03默认库事故](reports/test-database-isolation-incident.md)的152项／65错误／1跳过和实际库身份／影响未知、[旧35目录](reports/fixture-ownership-evidence-gap.md)全部恢复但旧库UUID仍0、[07／08旧嵌套CREATE](reports/nested-database-ownership-followups.md)的各四次缺口继续保留。没有连接、扫描或清理未知库，不宣称其他会话完全未受影响。

本次merger只实际运行 `npm run typecheck`、工作树／暂存／M2至HEAD的 `git diff --check`、Node标准库固定Git字节与文本合同、Conda下独立AST静态核对。原EOF失败已明确保留，修复后diff检查通过；001–063连续、前62与原根及前58与M2逐字节一致，063固定blob、十夹具迁移门及lifecycle尾序、codec2/schema4八类型、两种结构、500／三个SQL范围／3-16-2048及三处Grounded默认均静态通过。没有启动DB、HTTP、Chrome、App、微信、模型、探针或租约，没有新增动态成绩。

初次合并 `3e903976` 后与EOF校准合并 `df209de1` 后，均实际执行 `NOTALONE_PUBLICATION_ENV_FILE=/dev/null node scripts/check_public_history.mjs --ref main --working-tree` 及 `--ref HEAD --working-tree`，四次issues均0；只读main快照为 `9841bd1de4b1f339629b8dacfd6ffb188c4bf6f9`。签收记录提交后继续复验。检查只读本机引用，不吸收main后续变化。

本票数据影响为长期偏好、动作与使用依赖及固定上下文删除链；未迁移业务库，S分叉库保留，不合入main、不push／PR或部署。签收后9 resolved（01–08、14）、0 claimed、6 open，AC53已勾／38未勾；09仍open，持续目标尚未完成。实际App／微信和真实模型仍待最终组合。

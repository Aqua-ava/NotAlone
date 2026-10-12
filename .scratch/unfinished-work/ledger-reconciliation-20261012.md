# 2026-10-12任务账本对账

核查基点：`4e82176f5e971b4e4cdc67c6fa660bbe250cc510`。来源是用户要求对总览滞后、4张Skill票标签混用及两张已关闭旧票的验收承接按工作流处理。采用仓库允许的单会话小任务路径：核对问题／范围→文档与字段修正→最小相关验证→Standards／Spec双轴评审→本地提交。

## 范围与验收

- [x] 当前索引逐条覆盖202张原票，State／Triage与原票一致；统计为196 resolved、5 claimed、1 open，11张wontfix包含于resolved。
- [x] 总览、工作流导航及三份功能planning准确反映30票已关闭、172条验收已勾选；2026-10-11发布快照单独保留。
- [x] Skill库02–05只纠正无效的Triage值，State、验收和历史Answer不变。
- [x] native-app-backend/08、reply-module-flow/07逐条说明现行承接与缺项；未交付条目保留未勾选，不宣称已有承接票。
- [x] 额外发现的CLI01／04未勾选清单按本票Answer及06承接证据回填，明确这是历史证据，不是本次运行。
- [x] 六张未关闭原票、Blocked by、原验收门槛和产品实现保持；变更文件相对链接、字段、统计及差异检查通过。
- [x] 完成Standards／Spec双轴评审，并将本次账本变更作为独立本地提交保存。

## 核查结果与承接

1. 直接读取全部`.scratch/*/issues/*.md`，兼容普通、加粗和引用格式字段。核对前共202票、196 resolved／5 claimed／1 open，4张Skill票Triage误写为resolved；30张新票的172条验收已全部勾选。
2. 总览、跨功能导航、持续会话planning仍写未开工，策略／真实表达planning仍写中间集成状态。当前索引按原票生成，旧索引保留发布时快照，新增功能冻结、OCR暂停继续。
3. [回复闭环08](../native-app-backend/issues/08-reply-closed-loop.md#2026-10-12承接核对)：手动Skill已交付，实际依据只读展示由[Mac12](../mac-desktop-app/issues/12-reply-evidence.md)承接；逐项移除／补充生成上下文未交付，现行Mac规格明确排除，尚无独立承接票。
4. [SkillPort07](../reply-module-flow/issues/07-postgres-skill-port.md#2026-10-12承接核对)：选择方式和原因由[Skill02](../skill-library/issues/02-runtime-resource-loading.md)、现行SkillUse、迁移024、ReplyStore及公开HTTP投影承接；可空选择置信度仍无字段或承接票。上述两个缺项作为冻结期间的规格差距保留，不删项、不实施、不用关闭数掩盖。
5. 全量核查还发现[CLI01](../local-wechat-cli-observation/issues/01-cli-read-only-adapter.md)／[CLI04](../local-wechat-cli-observation/issues/04-local-observation-cursor-store.md)已有Answer却未回填五项清单。CLI01按本票历史14／14及只读冒烟回填；CLI04四项按本票历史9项存储集成、关闭停读项按[06](../local-wechat-cli-observation/issues/06-tail-lifecycle-catchup.md)历史13／13回填。旧前台同步语义与当前后台补齐分开，不扩大真实微信04的通过范围。

## 实际验证

在仓库根目录先执行`source /Users/local-user/miniconda3/etc/profile.d/conda.sh`和`conda activate NotAlone`，使用`python`静态核对：

- 202张任务的字段合法，当前索引202行无重复／遗漏且逐行相同；196 resolved／5 claimed／1 open，11张wontfix。
- 全部202张原票State不变，六张未关闭票与基点逐字一致；修改票的Blocked by不变，4张Skill票的原Answer及勾选不变，两张遗留票的原验收文字和勾选不变。
- CLI01／04只把已有历史证据覆盖的10项从未勾选回填为勾选；两张遗留票的未交付条目仍未勾选。
- 三份规格的现行30票验收分别71／63／38，合计172，均已勾选；各planning计数相同。
- 当前16份变更Markdown的616个本地文件链接和8个标题锚点全部可达。
- `git diff --check`及完整暂存范围`git diff --cached --check`通过；变更范围全部是`.scratch/`下的Markdown，没有产品代码、schema或运行产物。新索引暂存后发现的一个文件末尾空行已清理。

以上是本次执行的账本验证；原票14／289／9／317／13／437／567等历史产品结果未在本次重新运行。

## 双轴评审与收尾

- Standards首审发现5处评论位置违反`docs/agents/issue-tracker.md`的底部Comments约定：Skill02–05及native08。本次将整个Comments块移到Answer之后，保留原评论及历史Answer；首审问题未掩盖或删除。
- Standards复审：硬违反0、重要判断建议0、证据越界0；Spec独立审查：新增错误0、范围越界0、本轮对账缺失0。两轴仅只读核对，没有运行App、CLI、产品测试或业务库。
- 修正后再次静态对账通过：202原票／索引一致，8张修改票的历史Answer正文完整且各有一个文件底部Comments，六张未关闭票逐字不变，616个本地链接／8个锚点可达，30票71＋63＋38＝172条验收均已勾选。
- 本地提交只包含本次16份Markdown账本变更，提交主题为「按工作流校正任务账本与旧票承接」；提交身份由Git历史保存，未执行push或PR。

## 数据影响与交付边界

本次只修改任务元数据、账本索引和承接说明，无产品代码、公共接口、迁移或业务数据修改；不新增产品票、不改变原202票的State或依赖。没有App／CLI／微信、OCR、模型调用或部署；不读取私人资料、凭据或截图，不执行远端Git。六张未关闭票和两项冻结保留的规格差距继续按原入口处理。

# 正式11：审核发布候选与实际验证

日期：2026-10-16。本票仍为 `claimed`，六项AC保持未勾；本文件是交主Agent独立Standards／Spec审查的候选记录，不是签收或整批完成。

下文原始大组、SDK及页面成绩归属首版`5bb5bdf1436a09d4f3323f1d2392b98bfdff629b`；独立审查后的修复及新轮次单列于末节，不追认为原大组重跑。

## 固定范围与来源

- 独立分支 `codex/integration-11`，基线 `b7425f663aa0bcaf2d94bfa6c86afc0e5b281120`；M2、S仍为规格固定值。
- 取 `eaa8859f` 自身三路径请求合同增量（`skills/review.py`、`server/skill_learning.py`、请求单测）以及 `eaa8859f→aac75f16` 的11增量。基线09没有这三路径合同，不能只取后一个diff而漏正式入口；不是把Git的双点范围解释成包含起点。
- 源S065改名canonical066，SQL原字节相同。001–058=M2、059–065=本票基线，035审计清单和loader不变；065算法JSONB仍是10已签收的本地增量。只安装001–066，不查询未来067／068结构。
- 没有整文件覆盖已签收上下文。保留M2固定准备、任务/编辑/异步恢复、500条冻结补查与导航预算；保留09合法历史学习及完整样本/偏好世代，10升级删除链、Grounded与独立V、空质量维度表均不变。

## 最终行为与本地增量

同一次context build只替换策略，比较旧目标或NoSkill与隔离草稿，沿真实runtime、ToolStrategy及同一预算配置试用，不临时发布。编辑、范围、来源、偏好、目标与目录变化使旧对照失效。接受、编辑、暂留、拒绝各有明确动作；范围及替代关系双确认后，同事务幂等发布不可变版本及来源/方法身份。旧包`review_origin=false`不回填。

精确scene从请求进入权威输入、摘要、准备、继续、中断重试、探索及联系人缓存，目录缓存亦含scene；A→B→A恢复各自场景，旧无scene保持None。版本/范围显示来自实际使用身份。codec仍为version2/schema4：本票未改变其冻结值对象结构，command.scene由已验证权威输入重建，未给旧快照补字段。

删除在原锁序及事务内擦除对照输入/结果、私人草稿、发布依赖、版本/资源/方法正文与操作摘要，并扩展广范围跨联系人实际使用。新增本地反例发现已prepare但没有reply_request的明确Skill选择未进入删除根；修复沿真实version→skill→owner及已保存输入选定A turn，再由既有唯一派生输入选择器清除，首GET前直接SQL确认正文及快照为空。没有新增第二套依赖或冻结格式。

普通回复、探索与审核的共享模型在reply builder构造时明确`max_retries=0`；公共provider默认2和其他独立链不变，审核也核真实SDK实例/客户端均为零。DeepSeek ToolStrategy在安装factory中强制any并经SDK变为required，故该builder显式thinking disabled；输入编码只允许并浅合并这个已核扩展，DTO与实际HTTP body一致。已批准ECNU配置不加thinking，counter在最终模型构造后绑定；默认未知DeepSeek预算仍本地拒绝。未升级共享依赖。

Context7工具未提供，改核[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)及[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)官方合同，核实际安装langchain1.3.15、core1.5.5、deepseek1.1.0、openai适配1.5.1、openai SDK3.3.1。官方页面首次open超时后官方搜索返回合同；这不是外部模型成功证明。

## 最小反馈与原失败

采用已确认公开seam的tdd纵切。草稿端口先因模块不存在红，增加隔离实现后2/2绿；请求合同先8方法内3个反例得到404而非400，补缺失合同后8/8绿。前置命令曾错误使用重复backend路径及空Git pathspec，分别保留为工具/装配错误，不算产品红测。

SDK先有合成profile漏warning_ratio的夹具错误，修正后实际在非空extra_body预算守卫红；生产builder原无零重试/thinking参数的两个断言亦红，薄修后绿。首full5方法有2失败：未知工具名引发图恢复，允许3次后第4次MockTransport入口被本脚本cap拒绝，形成记录body3而callback4；读文件失败在第三轮确定性拒绝，原断言≤2不正确。后续严格错误使用畸形已注册输出，未知工具名的自动恢复不作为本票通过证据，不把成功脚本的3轮当功能通用上限。原日志和body全部保留。

新增跨联系人准备删除反例先红（input_payload/prepared_context残留）后绿；同键换scene为409且provider0。另独立单例在首轮provider持有输入时经公开PATCH同时修改偏好正文/范围/修订，迟到比较409、provider仅1、无有效comparison或发布；本例无产品修复。

原本地包56方法首轮运行到33时，固定未知`notalone_skill_port_error_test`连接在驱动前被guard拒绝并poison，teardown亦拒绝，2 errors；只在连接边界模拟OperationalError，恢复56/56绿。prepared/finalwriter21方法首轮第14方法的固定未知`notalone_reply_store_error_test`同样在连接前被拒绝，2 errors；首次patch实例因slots只读再产生1 error，改patch类连接边界后21/21绿。三轮各有独立自有库及原栈，未连接或清理那两个未知库，未放宽guard。

## 实际结果与分母

| 组 | 真实结果 | 边界 |
| --- | --- | --- |
| canonical066 | 缺066真实red；065→066及全量2/2；另generic1/1 | 旧整行只增review_origin=false，65账本/正文/hash/locator不变，重复0 |
| 公开审核 | 原21/21；删除增量后22/22；偏好在途另1/1 | 共23唯一方法，生产HTTP/PG/runtime，外部模型替换 |
| 旧本地包 | 恢复56/56 | 库/port/生命周期/资源/read/preview/export/删除 |
| 准备与最终writer | 恢复21/21 | 14个ReplyStore＋7个概览准备，含隐藏导航删除、旧格式、501条上限反例 |
| 学习与偏好 | 9/9 | 3学习＋6偏好，准备无request、样本与旧候选依赖 |
| Python unit | 1460/1460，14.179秒 | 包含新审核5方法；未把既有学习/升级SDK Mock计入新增审核分母 |
| Node相关 | 175/175 | 审核、scene、恢复、轮询和未知POST回执 |
| npm test | 65/65 | 含自有探针编译/签名；未执行探针或App |
| 单Chrome skill-review | 1/1 | 300秒cap、launch1、PG1、实际learning1＋reply9、真实外部0 |

PG/HTTP按实际method ID并集为**112唯一方法**，14分轮共197次测试执行；早期red/error不从分母抹去。上述后端分轮共16个新库，加页面1个，共17个均有精确planned→created→DROP→absence及关闭租约记录。每次CREATE前O_EXCL/NOFOLLOW0600/fsync登记，双URL在项目/test导入前绑定，核current_database；嵌套Core与独立迁移CREATE均在有限闭包内，拒绝后poison/failfast，仍允许已证自有cleanup。guard33、adapter12、实际hook8项纯标准库fake均通过；并未追认旧03/07/08未知库缺口。

SDK首批事前cap32/180秒，关账为31份允许/记录的Mock请求＋1次cap拒绝的transport入口（总32）；28份有原body/DTO，另独立green3仅有原工具输出，最终green13逐项body==DTO。500物理Mock派发1且before失败台账1；未知预算、绑定错配、附加正文覆盖model/messages/tools/output及超预算均0HTTP/0伪ledger。全unit另立新计划，新增审核Mock13全部逐body比对；**13不是整套unit的全部SDK调用数**。所有Mock固定loopback、synthetic key、traceoff、双httpx.MockTransport/trust_env=false，客户端均关闭；真实DeepSeek/ECNU调用0。

页面22个critical模块在ready前实际导入；首次因并发增加测试导致旧manifest SHA不同而失败，原栈保留，新冻结后22/22导入、0PG/0模型。实际页面封存276个运行模块原字节及2个执行artifact；权威响应清单4项/4唯一SHA，阶段封存12份browser字节亦只有4唯一SHA。最终逐文件对照275相同，唯一不同是页面结束后追加上述偏好测试；移除该新method后忽略位置属性的完整模块AST与已运行模块精确相同。页面测试不是Electron、App或微信验收。

## 证据与待审边界

仓库外私有索引保存每轮命令、原栈、PID/lease、精确库名、真实method ID并集、实际加载模块原字节及SHA、source delta与执行产物；原文件按SHA复核后封存，未把私人运行路径或原始载荷写入仓库。本文仅保留合成统计。最终候选由主Agent执行两轴独立审查及merger，票状态与六AC待其签收。

未验证真实模型语义质量、供应商token精度/上界、实际App/微信或业务数据升级；后续12/13的完整历史/回滚/范围政策未实现。质量门、词法检索、DSH关闭、人工发送、S分叉库保留、不合main及不push/PR边界保持。

## 独立审查修复增量

Spec的P2真实反例：with_source审核草稿编辑唯一合成description，compare/approve后删除来源，SQL仍读到目录及版本摘要。窄修只擦实际受影响`review_origin=true`版本摘要，并仅当该版本是current时擦目录摘要。008既有NOT NULL及非空CHECK不接受空串，采用固定无正文占位“来源已删除”，未改旧迁移。name保留既有slug最小身份；独立导入包、同一Skill独立新版current的摘要/正文/状态均保持。

Standards的P2由公开port真实PG返回列反例证明：原catalog投影含`version_content`。共享合法WHERE保持，catalog、资源许可及最终writer只选元数据；显式load_version才选所用版本正文，资源正文仍只在明确资源请求后读取。新例验证catalog无正文、load_version恰好一次正文投影、资源许可无策略正文。P3重复代码在审查阶段仅提取接收现有connection的运行中比较核验，保留两入口事务、草稿锁后重读、state/token/过期检查及原锁序。

15只读产品预检另发现审核来历含真实助手候选快照时，READ ONLY port沿历史读取执行`_ensure_original` INSERT。本轮公开反例先真实两轮生成、编辑/选择、学习、compare及approve，load_version报持久化错误；窄取`342e63a812bc95b2b42e4cabd8723244a062288c`自身两产品文件delta：历史缺原版时从权威候选只读投影，read不补写；编辑/选择写口保留ensure。删除的精确LEFT JOIN仅为version_id=candidate_id且全表不存在该ID时接受未物化原版，已存在但身份不匹配仍拒。第三处历史学习修复在首版已等价，不重复导入；未取未来067／068或EvolutionSupport。

最终组合第二轮实际捕获第一轮未编辑原版，再编辑/选择第二轮；实际审核版本load_version及正式runtime成功，第一轮原版始终0行，来源删除仍擦已编辑版本与审核副本。候选原有故障例调整为INSERT故障门下GET200且原版0行，编辑及选择故障仍503/回滚。

新guard副本先纯标准库33/33，再逐轮固定计划、cap及加载字节；未改guard或复用旧资源额度。摘要首red1→green1，catalog首red1→green1，组合首red1；一次在backend目录使用仓库根pathspec导致补丁为空，误起同字节重复red1，保留为操作错误。接入两文件后2个功能方法均过，但fixture清理后额外`count(*)`诊断被guard拒绝并poison，整轮2方法/1 teardown error；已DROP的两自有库由守卫及独立精确EXISTS再次核absence。fixture诊断等价改为既有允许的精确dbname EXISTS，没有放宽guard。

固定恢复轮HTTP35/35（审核26＋候选9，70.583秒）及投影/删除链23/23（3.412秒）通过；此前删除例使用原helper轮询来源GET后才查SQL，只证明较弱时点。两轮结束封存原字节后，增强三个用例：持有既有global worker锁，DELETE enqueue返回后、任何GET前直接SQL核两摘要、独立包/独立新版、草稿私人依据、版本正文/hash/locator、comparison、method、operation fingerprint、Skill使用request及编辑版本；该helper没有新增resource表SQL断言。另新1库轮3/3（9.288秒）通过，再恢复worker完成删除、GET/重启及拒绝旧批准。

本增量10轮69次方法执行、58唯一method ID均有绿证据；与首版112按ID并集为139。12个新增confirmed-created库均有精确planned→created→DROP→absence、PID及关闭租约；首红failfast的两个未用创建名不计实际CREATE。4401份实际加载记录的293种原字节SHA全部封存。原5bb证据索引不变，逐文件重新核原页面276模块，270相同，六个不同为四个产品模块与两个测试模块。本轮没有重跑页面、SDK批次或完整suite，不把旧页面/unit大组成绩归于新字节；前端、迁移及模型装配均未改。源码/数据影响仅为上述本地审核删除、最小读取和历史身份修复，保持claimed及六AC空，交独立增量审查。

## 2026-10-16：11同输入审核与范围发布签收

固定候选 `bd7d568200e2d8ad289ee9ff6caf5e7e6e620e6b` 以clean根 `b7425f663aa0bcaf2d94bfa6c86afc0e5b281120` 为基线，98文件manifest／固定Git blob／保存原字节逐项匹配。独立Standards原P2目录正文过读及P3重复核验、Spec原P2摘要删除遗漏均已关闭，完整及增量两轴最终新增及未关闭0；审查只读固定代码与既存证据，不是独立动态复跑。无冲突no-ff合入 `ce4c1151bb439759414b6deb938ed6591e92cd85`，merge tree `ce1f51b834dcff57f84f384879178c20d38f5324` 与候选完全相同。六AC与Answer齐全后签收；当前12 resolved（01–11、14）、0 claimed、3 open（12／13／15），AC71／20；12保持open，未领取。

原5bb：PG／HTTP112唯一方法、14轮197次执行、后端16加页面1库；修复新轮：58唯一方法、10轮69次执行、12库。method ID并集139，不是单轮139/139；原误标readonly-green的重复红、recovery-green两功能ok加一teardown error及postpoison两own ID absence保留。最终HTTP35/35（70.583秒）、projection/lineage23/23（3.412秒）、增强首GET前SQL3/3（9.288秒）分开；三例没有新增resource直接SQL断言。29个本票确证created均按精确名称DROP／absence，仅核已知本票资源。

原unit1460／Node175／safe65／页面1/1归首版5bb；最终页面270/276模块原字节相同（四产品、两测试变化），未重跑suite或页面。原SDK总cap32入口为31 allowed/body-accounted（28原body/DTO，另3只存原工具输出）加1cap拒绝；全unit另审核13 Mock不是整套SDK总数，外部0。页面learning1＋reply9/总10、300秒cap、Chrome1、2 artifact／4响应4唯一SHA／12保存字节4 unique均只属原轮，不证明实际App／微信。原新证据、来源342两文件及修复分轮仍在上文原记录中，不覆盖或追认为全绿。

merger本次实际仅运行 `npm --prefix desktop run typecheck`、工作树／暂存／base／固定M2的 `git diff --check` 与Node标准库静态合同，全部通过。001–066连续，旧001–065与base、001–058及035与M2原字节相同；canonical066=S065原字节（SHA256 `b6347262bd3c488fb1cdaa0fbdffa9ff1ff1a16a851ab1113ab9d6b748814c9a`），065的10算法JSONB本地delta保持。审核选用严格66／066／重复0门；旧053／058／061／063／064／065 setup与既有夹具边界不机械改号。codec2/schema4因无新encoded fixed字段保持，scene由权威输入重建，500／三处SQL范围门／3-16-2048／三Grounded默认保持，未来067／068表查询0。初版私有scene正则断言误用payload.get而实码为content.pop，修正静态检查后通过；另一次只读glob不存在为工具错误，二者均不计产品通过或失败。

合并提交后 `NOTALONE_PUBLICATION_ENV_FILE=/dev/null node scripts/check_public_history.mjs --ref main --working-tree` 与 `--ref HEAD --working-tree` 均issues0；main只读引用 `56051719ffa8881e53daf1040208b05aeea61087`，未吸收漂移。签收提交后继续复验。冻结issue-index.tsv不改，真实integration索引仍为11列、16行、160个tab。

没有新增PG、HTTP、模型、页面、App、微信、探针或租约执行；只读既存证据索引，不访问S库或未知历史库。03事故152方法／65错误／1跳过的实际DB及影响unknown，旧35目录DB UUID0、07／08旧各4嵌套UUIDunknown仍未关闭，不连接／扫描／删除未知库，也不声称其他会话无影响。默认质量门与DSH未开启，业务升级及实际App／微信、真实模型质量另验；S分叉库保留，不合main、不push／PR或部署，本票完成不等于整个持续目标完成。

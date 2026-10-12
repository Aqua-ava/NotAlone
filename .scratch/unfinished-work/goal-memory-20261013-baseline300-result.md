# 第三／最后一次当前记忆基线：安全停止与闭账

本场因 A05 的评测 `bad_auto=1` 按预注册安全停止，5窗完成、16窗未运行；不是有效完整21窗基线或质量通过。原 07 的至少15条／假事0／记错人0／一般错误≤1门槛、核心原真实严格6/12／可选2/6和分维度票未完成状态不变，默认放行表未改。预注册见 [baseline300 计划](goal-memory-20261013-baseline300-plan.md)；唯一 run `c02248b0-ad08-4d09-9fb7-edf21539081a`、cap42，实际10次真实HTTP全部200，持久预算closed，余32永久关闭；旧关闭余额和候选54／全量280／预留9均未激活，无第四次基线。

本轮固定 Taipei 03:25–05:25，每次起发须早于05:19:15；实际入口300秒、重试0与原21窗／Gold／E-V提示保持冻结。03:26:25 包装器错误向 `main()` 传位置参数，产生 TypeError，发生在注册、预算与HTTP之前，新增真实请求0；失败记录 `/private/tmp/notalone-memory-goal-20261013-ac04d687/baseline300-first-wrapper-failure.json` 保留。03:26:47.867719 再核同 UUID 缺席、起发时间及冻结守卫通过，按冻结入口唯一启动，没有滚延窗口、换ID或再建预算。

每窗先实际完成E/V，再提供E-only raw视图；操作者逐字段审核，原持久记录封存raw后才揭示V／程序去向，全程没有默认通过。审核装配辅助程序仅复制摘要、校验显式判断并独占0600保存，不进行HTTP、凭据或业务存储操作。A01–A03第一检查点实际6次／closed=false与当时累计20保留在先前记录，终态只读真实SQLite核10次／closed=true。此次10次由真实SDK与持久预算约束的真实transport发送，没有重试；请求模型`ecnu-max`与响应报告alias `deepseek-v4-flash`分别记录，alias不证明权重身份。

|窗口|必需命题|raw／程序接受／完整契约|实际缺陷与程序去向|
|---|---:|---|---|
|A01|2|2／2／0|13个E槽通过，备选补本窗未给的同事／朋友角色失败；V可见字段及证据通过，最终pending。Mac独立事后E-only复核同结论，不冒称首次盲审。|
|A02|1|1／1／0|report/reported却拼recent_state和周末日期；恢复老李身份所需context0未引用，V supported未识别上述契约缺陷；最终pending。|
|A03|1|1／1／0|13个E槽通过，备选补本窗未给的亲友／熟人角色失败；借款、歧义及report/reported保持pending。|
|A04|1|0／0／0|正文遗漏“先”的暂时性，category=taboo、观察valid_at为空、未知事项alternatives为空；V未发现暂时限定与字段缺陷，最终pending。|
|A05|1|1／1／0|历史已发生的本人接收借车经历被装配成recent_state及来源日valid_at；V未发现分类／时间缺陷；评测理想三门路径auto，审计bad_auto=1触发停止。|

前三窗按普通错误继续，A04亦没有确定假事／错人或错误auto，A05才触发安全停止。5窗共6必需命题，raw／accepted为5/6、full为0/6；16未运行窗和原21窗28必需分母完整保留，不把5/6当整场质量。70个E槽中12失败：text1、category3、source1、valid_at3、invalid_at1、alternatives3；其余58槽通过、审核未决0。5条V输出中3条语义失败（A02/A04/A05），对应verdict3、issues3失败；真实逐字证据与合法index不代替完整语义。重复、额外、确定假事、记错人和未映射项均0；错误auto1只来自原评测的理想三门去向，**没有生产业务写库或维度放行**。生产默认空集是独立第四道门，本结果不能宣称产品实际自动采纳。

五份完整审核各有原raw回执与独占文件，先封存后揭示的原判断未重写。55个持久事件逐payload摘要核验通过，最终事件明确`safety_error/contract_mismatch`，完成收据 `e9f914a26d0ac90f270672b20e76dc7b5137d7adb8dfbec2f65978b084427dc9` 记录5completed／16unrun／plan_complete=false／quality=false／capture_gaps=[]。源码60项与冻结字节零漂移；budget配置实际timeout300／max_retries0。原输出程序仍把4/5判passed，与独立完整语义0/6分开，不拿旧matcher救分。

安全停止后，本场摘要保存出现TypeError，CLI session31515实际exit1；`run-result.json`／`run-summary.json`未生成，不能伪造原驱动monotonic耗时或摘要。已保存manifest→receipt落盘窗口实际为**642.991830958秒**，Taipei03:26:47.938109–03:37:30.929940（基于文件mtime，非原monotonic）；此前5个驱动累计600.3452016669617秒与本场时间指标分别报告。本目标累计真实请求**24**，已确认HTTP200共20、此前ReadTimeout4的远端结局仍未知；所有6个run均持久关闭。

离线诊断以获准公开5窗已封存E/V重新调用原纯评测，不构造SDK／供应商或业务数据库，禁网络。冻结桥在`probe.write_private`直接`json.dumps(run_ecnu_evaluation返回结果)`，原asdict(Fact)中的UUID／datetime未转换；5窗均复现该TypeError（A02首先碰到datetime，其余首先碰到UUID）。用记录器原严格`_json_value`规范化后5/5可序列化，规范摘要5/5与真实case_result一致；该结果只定位收口工具错误，不改变原语义成绩或复开预算。诊断与对账新增真实HTTP0。两SDK客户端关闭在原batch finally执行，完成收据仅在无客户端关闭错误时落盘；本场收据可用与CLI退出支持该收口路径，本机评测入口进程已退出，SIGALRM context退场后清除并恢复handler。没有App、微信、OCR或业务库资源由本Agent启动。

私有公开合成证据根目录 `/private/tmp/notalone-memory-goal-20261013-ac04d687/`（0700，文件0600）：`baseline300-reviews/00-A01-*`至`04-A05-*`为raw/full视图与审核；`baseline300/{manifest.json,event-000001.json…event-000055.json,completion.json}`为真实持久记录；`baseline300-terminal-derived.json`为原摘要失败后仅从已闭账记录推导的元数据，明确不是原驱动摘要；`baseline300-serialization-diagnosis.json`为5窗离线复现。真实预算 `/Users/local-user/.notalone-memory-evaluations/c02248b0-ad08-4d09-9fb7-edf21539081a/budget.sqlite3` 用mode=ro复核。已关闭余款38／2／40／1／32全部不复用；未来54及280／9未激活。不读取真实聊天、不跑App或桌面、不上传私人资料、不提交模型原始响应或秘密。

下一步仅准备最小修复候选：必要上下文若恢复人物／对象则必须纳入原来源；身份或事项未知的alternatives只保留无法唯一定位，不补角色或秘密正文；已发生无明确期限的亲友参与经历与当前仍持续状态分开，不把消息观察日期当历史事件开始，临时请求保留“先”及观察点。V按已引用必要上下文与历史／状态字段逐项核，不能用一条真实quote掩盖分支缺陷。Root已允许上述最小E/V修复与独立候选准备，当前产品源码仍短暂冻结供C最后47项实机场；候选真实调用仍未授权。新不可变amend-v4须显式撤销“完整21控制才启动54”的旧准备条件，改为已有5窗正式安全停止与技术E/V完成、旧run持久关闭，并保留旧计划／16unrun／余32和禁止第四次基线。候选保持完整21窗Gold、一条不删；原对照只有前5可成对、后16未知不能伪称完整paired控制。Root在相关最小验证、双轴、有限预算与源码最后冻结通过后才能授权执行；当前54／280／9仍未激活。新的外部driver在保存处使用原严格JSON转换，保留旧冻结桥字节，不为补摘要重开已关闭stage。以上准备不证明模型效果，也未改schema／门槛／默认空表。

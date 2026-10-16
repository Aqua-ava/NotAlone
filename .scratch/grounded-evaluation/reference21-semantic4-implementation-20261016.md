# 原公开21窗semantic4：离线实施记录

日期：2026-10-16。离线实现及下述验证已完成，待Root独立审查、提交和最终冻结；真实台账／请求／凭据读取均0。精确范围见[固定计划](reference21-semantic4-plan-20261016.md)。新固定公开质量合同复用legacy四槽；旧已注册评测profile、三个adapter默认合同及Gold保持，未注册proof2评测helper的对齐差异见下文。typed未评估且无信用。

接缝已由主Agent按持续任务明确：既有adapter＋实际SDK Mock、reference21同一runner的prepare／validate／worker、预算／记录／RAW-FULL／owned控制。先红→绿，再完成完整21 Mock及负控；完成后由Root双轴审查、提交、冻结核验，未核前不读取key或运行真实模型。

## 验证记录

1. 实际SDK四槽切片：新`prompt_profile`参数起初真实adapter报TypeError，1 error红；加入封闭提示合同与adapter同源装配后1通过。唯一原具名工具、严格四槽／无proof、作者包装追加原则均在真实SDK Mock wire中核对，不使用strict或新增API参数。
2. 完整21切片：同一runner起初不接受`profile=semantic4`，1 error红；逐层注册新身份后完整Mock到B02，21E＋19V＝40／42、21窗、42个RAW／FULL阶段并持久闭账。仅给定A12／A14空E，不按Gold跳过请求。程序没有verification_program事件，输出typed_evaluated=false、typed_credit=false；人工给定标签及审核不作模型质量成绩。
3. `python -B -m unittest discover -s desktop/tests/fixtures -p test_reference21_v4_public.py -v`：10项通过，27.019秒。包括旧默认完整21、新完整21、新四槽收到proof=null／对象时真实响应及adapter原件先保存后严格停批、仅2预约且余19窗unrun；源快照、message_snapshot、已知类型或文字表示在预算／key前拒绝；unknown／safety不继续；旧冻结／授权／范围漂移与跨140模式负控保持。之后新增最终纯prepare控制，供Root在最终文档后窄核。
4. `python -B -m unittest discover -s tests/unit/memory_extraction -t . -p 'test_evaluation*.py' -v`：210项通过，91.514秒，含预算、记录、参考、phased、旧provider配对和真实owned回收。日志`desktop/artifacts/semantic4-evaluation-unit-20261016.log`仅本机忽略产物。
5. `python -B -m unittest discover -s tests/integration/memory_extraction -t . -p 'test_evaluation*.py' -v`：113项通过，114.298秒，覆盖旧ecnu／官方／完整140／原21／offline／SDK预算及wire合同。日志`desktop/artifacts/semantic4-evaluation-integration-20261016.log`。
6. 来源proof、作者引句proof2、Flow／V提示／adapter和实际wire六模块组57项通过，2.264秒；日志`desktop/artifacts/semantic4-adapter-proof-20261016.log`。兼容断言来自变更前实际字节：legacy／nullable1／proof2 adapter的三个原提示与schema摘要逐一保持。追加“评测helper与实际proof2合同同源”及“旧原21仍拒proof2预算前准入”的2项窄核通过。
7. `python -B -m mypy --follow-imports=silent`检查7个修改backend源码及同一reference21 runner：首轮fixture字典推断导致2个参数类型错，补profile映射注解后8文件通过，日志`desktop/artifacts/semantic4-types-final-20261016.log`。本片已跟踪文件`git diff --check`通过。

命令分别在根目录（runner）或backend（后端测试／类型）运行；先加载当前Conda shell并激活NotAlone，设置NOTALONE_DISABLE_DOTENV=1及适当PYTHONPATH，类型附MYPYPATH。测试仅合成凭据、Mock transport及临时独立home／SQLite，不读取真实key或业务PG。各组存在覆盖，不合并成新模型样本总数。

## 已注册合同与未注册helper的区别

SOURCE_VERIFICATION_SYSTEM_PROMPT与三个原schema常量均未修改；实际adapter默认legacy、nullable1及proof2各自的提示／schema字节保持。旧评测默认、nullable1及全部已有执行身份的准入配对保持；新semantic4提示不能用于proof模式，proof2仍不被任何评测记录／旧原21或新semantic4身份准入。

本次把评测`_verification_contract`改为调用实际adapter共用函数。因此**未注册的nullable-proof-v2评测helper**由旧误返legacy四槽的提示／schema，改为返回真实proof2合同；该helper行为不再称旧freeze函数全部字节不变。其与实际adapter同源有直接断言，现有records仍拒绝proof2，旧／新固定身份均在预算／key前拒绝该模式，没有开放proof2评测执行或改proof2解析／语义。

## 源闭包与交付范围

实际新闭包89份，对原21基线86份增加本计划、本实施记录和matter_reference spec三份；不是照抄旧数量。仍包含原公开21参考／中文判据、全部实际backend依赖、runtime_config、当前runner、原helpers／显式审核桥、当前v4相关spec及ADR-059。未加入完整140 Gold或读取私人源，原参考内容／输入／顺序／28＋1分母不变。

本片15文件：7个backend源码`verification_adapters.py`、`evaluation_provider_contract.py`、`evaluation_offline.py`、`evaluation_ecnu.py`、`evaluation_records.py`、`evaluation_phased_audit.py`、`evaluation_owned_process.py`；同一`desktop/tests/fixtures/reference21-v4-public.py`；测试`test_verification_adapters.py`、`test_evaluation_reference21_v4_contract.py`、`test_evaluation_wire_contract.py`、`test_reference21_v4_public.py`；ADR-059；本计划及本实施记录。没有新runner／harness／依赖／SourceVerificationMode或供应商枚举，未动importbridge、grounded已提交源码或其他Agent任务票／父进度。

Root最终审核／提交／历史扫描及新freeze绑定前不真实启动。旧场、额外proof失败、未跑分母和所有硬停保持；不认证A01误拒已修、A05标签会正确、原21必然跑满、至少15质量门、私人核心／留出或逐类放行。暂无新真实registry／预算或自动后继；默认空表及生产grounded-v2不变。

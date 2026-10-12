# 原始审核封存接点验收结果（2026-10-13）

承接[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)与[受限规格](memory-phased-audit-spec-20261012.md)，基点`15334e81`。新增功能冻结、OCR暂停。公开合成材料、假凭据和精确Mock验证；真实供应商／HTTP、业务库、App／微信／OCR操作均0，没有读取秘密值。

## 实际行为

[PhasedEvaluationAudit](../../backend/src/notalone/memory_extraction/evaluation_phased_audit.py)先核固定21窗参考及当前输入，只向raw审核回调提供E原项、当前窗和Gold。E14字段、含义／纳入／安全／分类／依据与命题组显式填写后，保存并验证私有raw事件回执；这时才向full回调提供实际V输入、V与程序层。full不能改写已封存的raw判断，完整计数报告先保存，再返回原ECNU四键决策。语义仍由Agent判断，没有自动中文评分或默认safe。

[shared批次](../../backend/src/notalone/memory_extraction/evaluation_offline.py)提供仅接收payload的保存能力，内部固定当前case和有效状态；只允许raw→final各一次，回调结束即失效。回执核归属、先后序号、原值／摘要及无脱敏缺口。实际[ECNU入口](../../backend/src/notalone/memory_extraction/evaluation_ecnu.py)在读取凭据前拒绝旧审核协议或不匹配criteria；精确Mock保留原工具回归协议。保护生产prompt／schema／Flow、公开case、原matcher与默认空放行表。

## 验证与审查

新增phased单组13／13与整场接点4项，本片新增17项。Root最终18模块完整相关 **242／242通过、8.647秒**（225＋17）；在Conda NotAlone、backend目录使用自有临时标准库脚本，清空环境只留disable-dotenv，禁止HTTPX／HTTPX2公共及_client默认transport、socket connect／connect_ex和DNS。没有真实供应商或产品factory执行。3份源码mypy无问题。

实际red→green包括缺phased模块、非法raw／保存回执、封存字段改写、V请求漂移、输入变动及真实模式旧协议未先于loader拒绝。原始回执接点缺保存能力时整场无回执，新协议接点补入后通过；phased使用实际store的三事件保存顺序检查初次即通过，不虚构red。

Standards初审发现1项硬问题：保存能力把case_position/state设为可被调用方覆盖的默认参数，窗口归属和过期限制可绕过。Root新增覆盖参数回归，修复前因整场审计未完成而red；改为私有工厂闭包、公开函数只收payload后，参数覆盖、回调结束重用及保存归属检查green，4项接点再次全过。Spec主体初审无额外发现。最终代码及文档双轴增审：Standards0项、Spec0项未解决发现，保留初审问题及修复记录。

5份本片Python的AST通过，4份Markdown的91处本地链接目标可达，原07完整历史prefix和5条未勾验收保持。首轮保护字节检查误列不存在的ports.py而中断；按实际文件清单修正后，17份生产源码／公开case与空放行台账和基点字节相同。这是静态检查路径错误，没有伪称首轮全部通过。差异空白检查通过；账本保持203票、196resolved／7claimed／0open。提交前对本主题9文件再核暂存差异，不推送。

## 真实运行停止点

本轮仅检查运行环境是否包含`NOTALONE_EVALUATION_API_KEY`这个键名，结果false；没有读取值、`.env`或产品密钥。这个结果只证明本轮进程环境缺专用入口，不推断ECNU账户没有密钥。用户需要在本机隐藏输入准备评测凭据，不能把产品`.env`作为静默fallback。

已按wizard skill准备仓库外一次性向导，库保持逐字相同；单阶段隐藏输入已有ECNU API Key，保存在本轮0700目录的0600 `credential.env`。生成时该文件不存在，向导不启动模型、不写产品.env／CI或仓库。后续明确loader只在持久batch领取后读取此文件，不依赖用户终端export传回当前Codex进程；使用结束删除本轮凭据。`bash -n`通过，shellcheck本机不可用，未虚称运行；这里只做静态／语法检查，不代用户运行交互输入。

仓库外向导另经只读审查发现临时副本边界：模板write_env的mktemp若写入中断，可能留在本轮私有目录外。未改库，只在stage建立本轮目录内自有临时子目录，为write_env局部指定TMPDIR，EXIT／INT／TERM／HUP清理自有目录；先写pending文件，完整后同目录替换最终文件，失败不破坏已有完整凭据。修正后bash语法、库字节和0700权限再次核对；以固定假值单独验证write_env正常及cat故障退出两条路径，0600结果／未完成文件不晋升／临时子目录清理均通过，未运行交互向导或读取秘密。向导最终只读复审0项待改，不把它算入242项仓库回归或真实执行冻结。

工具接点通过不代表模型质量通过。唯一真实run／0700目录、提交与源码字节对应、实际版本、aware期限和等待中的审核回调退出仍需完整运行冻结；42／84未激活、旧预算关闭。原07继续claimed／needs-info、模型验收0/5，真实核心6/12与默认空放行保持。凭据只在持久领取后由明确loader提供，实际运行仍限ECNU公开合成21窗，不自动P2或重开失败P1。

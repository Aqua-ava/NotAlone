# 结构化标准答案与显式审核装配结果（2026-10-12）

本片承接[原07票](../memory-extraction-accuracy/issues/07-reference-resolution.md)与[实施规格](memory-structured-gold-spec-20261012.md)，基点`b947e853`。新增功能冻结、OCR暂停；真实供应商／密钥／私人模型返回／业务库／App操作均0，只有公开合成资料、假凭据和Mock。

## 参考材料

[JSON参考](memory-gold-reference-20261012.json)固定21窗、28必需＋A15可选1、34个整组variant、40个来源选择；A12/A14为none且窗口保留。gold_field_review独立复审初始装配字节及全部中文语义、日期、来源条件与provenance，0实质差异；另用标准库从公开case AST重建21窗口的UUID／时间／空snapshot／input SHA和target，0差异。Root只追加复审引用，当前摘要见[装配记录](memory-gold-reference-20261012.md)。整理者已见旧oracle，只有A14纳入性由用户抽查，不能称首次盲标或全窗人工认证。

Root静态复核21窗输入摘要、28＋1／34、当前annotation摘要、来源范围／target、日期／结束先后、only A14 human与质量false均通过；初次AST字段校验只识别Assign，遇schema的AnnAssign在最后一步报StopIteration，改成正确节点后E14／V4字段及顺序精确通过。它是检查脚本问题，不是产品red或模型错误。

## 审核计分与实际输入

[纯审核模块](../../backend/src/notalone/memory_extraction/evaluation_review.py)提供准备和评分两个Seam，校验允许JSON、索引全量、各层payload／reference／evidence／packet摘要、显式E14／V4／命题证据组及未决状态；人工技术判断由Agent填写，工具只做完整性和计数。摘要用于检测意外漂移，不是签名或抵抗有权重写材料的防伪认证。

[shared批次](../../backend/src/notalone/memory_extraction/evaluation_offline.py)只补已有脱敏provider_requests供回调核实际V输入。V序号对应Flow的reviewable列表，不能按E原序号猜；没有新增捕获范围或headers／内部思考／秘密旁路。新增[整场接点回归](../../backend/tests/integration/memory_extraction/test_evaluation_ecnu.py)实际2次Mock E→V后停，red为缺provider_requests的KeyError，补2行后green，回调值与已保存事件一致且无假key。

## 验证与审查状态

纯审核单组16／16，新增[公开参考加载门](../../backend/src/notalone/memory_extraction/evaluation_reference.py)与[加载回归](../../backend/tests/unit/memory_extraction/test_evaluation_reference.py)5／5；回调接点新增1项，合计本片新增22项。加载门以调用方实际独审固定的期望参考摘要和显式中文摘要核绑定，再校验公开21窗输入／顺序／target、28必需＋A15可选1、none范围、E14／V4和仅A14用户抽查；通用单窗prepare不能代替它，也不自动认证中文语义。

Root最终17模块完整相关 **225／225通过**（旧203＋本片22），unittest 7.235秒；使用本轮自有临时标准库回归脚本，在Conda NotAlone、backend目录，清空环境仅保留disable-dotenv，禁止HTTPX／HTTPX2公共及_client默认transport、socket connect／connect_ex和DNS。没有运行真实评测main或产品factory，ECNU单组累计100次Mock dispatch（原98＋新增2）。3份源码mypy无问题；数据只来自公开合成集。

实际red→green包含审核模块缺失、漏行／重复／摘要／枚举／basis及V索引、错误variant／拼字段误计full、额外坏auto报告、失败非法对象和实际V输入漂移；增强V输入核对后一个时区夹具漏同步V时间，已修夹具。failed／unknown的raw规则依独审后的规格修正，不冒称原规则一直如此。Root加载门red包括缺模块、删窗／换name／input／target／position／id／分母／none仍进入、来源／复审／抽查范围可替换，以及当前E/V required变化未拦；对应修复后green。早已通过的摘要拒绝不虚构red。

初次Spec发现两项：缺真实21窗加载门、有效E后V失败被误清raw；已分别补上述Seam与保留已审raw信用，接受／完整及正确none仍为0。Standards代码0硬违反／0代码smell行动项，文档2项状态判断已修复；Spec另有1项README下一步文字滞后已修复。最终全范围及元数据复审：Standards0项、Spec0项未解决发现，不省略初审问题。

6份本片Python的标准库AST和差异空白检查通过；5份Markdown的95处本地链接目标可达。原07历史完整prefix及5条模型验收未改，17份受保护生产源码／公开case／原matcher／放行台账与基点字节相同；当前203票、196resolved／7claimed／0open保持。只提交本主题12文件，不推送。

## 执行边界

结构化参考独审和机械计数都不代表模型质量达标。完整packet同时含E/V/最终层，不能证明raw先审封存；实际运行前仍须装配仅先揭E视图、私有封存raw审核、再揭V／程序层的次序和完整运行冻结。42／84未激活、旧预算关闭、原07的模型0/5、真实核心6/12与默认空放行保持。

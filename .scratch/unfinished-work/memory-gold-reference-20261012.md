# 公开合成结构化参考的装配记录（2026-10-12）

已按[结构化参考规格](memory-structured-gold-spec-20261012.md)装配[JSON参考](memory-gold-reference-20261012.json)，来源为[已审中文判据](memory-gold-agent-annotations-20261012.md)。只新建这两个文件，不改中文语义、旧case／oracle、产品代码或生产放行；新增功能冻结，OCR暂停。

## 初始装配状态与数量（复审前快照）

- 固定21窗，28个必需命题、A15-P2可选1个、34个绑定正文／字段／来源条件的variant；A12/A14均为none且保留窗口，多个variant不增加同一命题分母。
- E14、V4和中文通用判据原样保留；逐variant的topic、风险、alternatives、reason、日期与理想去向均显式装配，不用允许字段的笛卡尔积。
- A06等行李的来源按是否明确机场绑定；B01条件咨询按是否明确课程关联绑定。所有source choice有indices和when条件，含target且在本窗；全部禁止增强项另列。
- `status=agent_reviewed_reference`只表示装配引用已审中文判据，`provenance.structured_review=pending`明确**JSON装配本身尚待独立复审**。仅A14纳入性为实际用户抽查；已见旧oracle、非盲标、`quality_certified=false`均保留。不宣称模型成绩、真实分布、真实6/12或生产放行。

## 本次静态验证

Conda `NotAlone` 内使用 `NOTALONE_DISABLE_DOTENV=1 PYTHONDONTWRITEBYTECODE=1 python -I`，只导入公开cases与其公开窗口类型。21个input摘要逐项与从公开源码AST直接提取的原 `build_window` 和原 `canonical_sha256` 纯函数一致；未导入HTTPX、OpenAI或LangChain DeepSeek，不构造SDK或读取密钥。

固定顶层／window／claim／variant字段、21窗公开名称／顺序／target、21／28／1／34分母、29个claim ID和34个variant ID唯一、每组来源界限与target、日期带时区且结束晚于开始、JSON round-trip、E14／V4列表、none窗、用户抽查范围与未独审状态、文本空白均通过。初次内联脚本括号SyntaxError在执行／写文件前被拒；改正后分段装配，所有输出均为公开合成资料。这里只认证装配结构，不认证中文语义或运行效果。

## 初始装配摘要

| 项目 | SHA-256 |
| --- | --- |
| 中文判据原文件 | `7039a302f64d6a14761ae448e425597c5ef46e0fbb3d7bc41c95c6d9a9b91e91` |
| JSON原文件 | `9161944e41236328ad15a70f897074c4123e7f0e1877b5fb728fb1cdabdcba21` |
| JSON规范值 | `90f94c656d26795e5d28b587d91fafa40ef7295e9004b756cb5795a31498662f` |

上述为`structured_review=pending`的初始装配摘要，后续独审引用或修正改变JSON时须重新记录摘要；不能拿旧摘要冒充最终运行冻结。

本次真实请求／密钥／私有结果／业务数据库／App／微信／OCR均0。只创建自有公开参考文件；自有Python交互进程已正常退出，不创建提交。下一步由其他Agent复核JSON与中文判据的一致性，再由主Agent承接结构化评分装配、相关验证和任务专属本地提交；当前不开放ECNU执行。

## 结构化装配独立复审

gold_field_review已对上表初始字节摘要的JSON逐项独审：21窗、28必需＋1可选、34个variant、40个来源选择，全部与已审中文判据一致。A02三组合、A10每命题二组合、A15可选二组合完整绑定；来源正文条件、观察／期间／政策日期、topic／risk／alternatives／reason、none禁项与仅A14用户抽查均无实质差异。另以标准库从公开case AST重建21个窗口的UUID、时间、空snapshot、输入摘要、顺序与target，0差异，未导入项目／SDK或联网。

Root据实际复审将provenance.structured_review由pending改为带审查者、所审原摘要和范围的passed对象；仅此审查元数据改变，命题／variant／来源／日期／判据字节未重写。原初始摘要仍保留作被审对象，不冒充当前文件摘要。实际模型输出审查、先封raw再揭V、源码／版本／期限等最终运行冻结仍未完成。

provenance.independent_review.description保存中文判据独审当时的说明，其中“JSON装配本身尚待另外复审”是该历史阶段的状态。当前JSON装配复审以provenance.structured_review的passed引用为准，不把旧描述继续列作待办。

复审元数据追加后的当前JSON文件SHA-256为`5ab68ad8fbb48348231b27ae600ca011e47bf7fc2c1aa2f4e5b417bfa392d5a6`，规范值摘要为`5fb8d53b90a1a96c5987ac7b825bb233cc3e9f196f976e4851c40b0243b77b32`；这是参考材料摘要，不是最终run／源码／配置清单摘要。

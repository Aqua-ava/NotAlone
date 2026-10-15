# 公开来源参考 v2：A05 归属保真修订

Triage: ready-for-agent
State: resolved

日期：2026-10-16。状态：最小实现、离线结构验证及独立Standards／Spec审查完成；参考仍明确pending，不授执行资格。不是新模型场、业务变更或维度放行。主工作树基线为 `fb6a4b3a`，既有未提交改动及其他 worker 的 v4 实现均保留。

## 问题与来源

原21的 A05 判据要求“姐姐自己的车”、空 alternatives、理想 auto；这与已批准 [D2 第87行](../unfinished-work/goal-memory-dimension-proof-interface-decision-20261013.md#L87)冲突：原句没有 Identity，姐姐作为出借施事明确，但物品车主不能靠施事或代词性别确认。既有 full140 嵌入并逐值保留原21，所以也承接了同一问题。R105 已正确保留受益人未知，不修该窗。

本次只形成未来独立使用的 `source-fidelity-v2` 参考：原输入不变，旧参考和所有旧运行／冻结／审核成绩原件不变，不重算旧结果。整理者已见旧 oracle 与旧结果，非盲标；结构通过不等于语义独审通过、模型质量或真实执行就绪。

## 行为与材料范围

- 新增 `.scratch/unfinished-work/memory-gold-reference-v2-20261016.json` 与对应 `memory-gold-agent-annotations-v2-20261016.md`。
- 新增同目录 `memory-gold-full140-reference-v2-20261016.json` 与对应 `memory-gold-full140-agent-annotations-v2-20261016.md`。基底为已经修正 R025／R031 承诺风险及 R024 历史更正分支的现有 full140；新增119逐窗、来源档案和映射不变。
- A05 保留姐姐出借、联系人接收、本人参与的已发生经历；仍为 `contact/relationship_note/assertion/asserted/literal`、H 双 null、原 `family` 与唯一来源选择。车主未知，正文和非空 alternatives 明确“她”缺唯一指称，理想 pending；不补 Identity、不断言姐姐不是车主、不改成纯第三人 report，不捏造金融风险。
- 只修 A05 及直接受影响的通用歧义规则和版本／历史来源元数据。21窗28必需＋A15可选1；140窗138必需＋1可选、156分支／162来源选择保持。其余窗口逐值、原消息／sender／时间／target／UUID／输入摘要、公共 oracle 和旧评分器均不改。

## Implementation Decisions

既有纯 Module `evaluation_reference.py` 的 `validate_public_reference` 与 `validate_full_public_reference` 是版本绑定验证 Seam。新增 keyword `reference_version`，默认 `legacy-v1`，另一封闭值仅 `source-fidelity-v2`；拒绝错误类型与未知值，不接受调用者任意路径。旧常量、默认判据、返回形状和默认复审要求保持。

v2 的版本／path标记置于 provenance，保持原九个顶层键；显式绑定新21／140路径、当前参考规范摘要、中文判据字节摘要、历史来源绑定及 full140 的新 parent21 文件／规范摘要。同版本首21必须与嵌入 parent 完全一致，规则作用域与映射继续校验。新版冒充旧版、旧版冒充新版、跨版 parent／annotation 和首21不一致均拒绝。验证器不读文件、不联网、不认证中文含义；调用方仍提供实际材料摘要。

红→绿发现既有 `prepare_case_review` 同时要求引用结构与 `agent_reviewed_reference` 资格；Root明确扩大本切片所有权到 `evaluation_review.py` 及其unit测试，批准抽出 `validate_reference_structure` 纯结构Seam。该函数只核精确九键、原字段与窗口／命题／分支结构，返回 `None`，不生成packet、不改真实status、不授执行资格；`prepare_case_review` 保留原精确九键及已审status门，评分算法不改。v2在已核固定版本／路径／摘要／真实pending元数据后仅调用纯结构函数；不构造假已审视图，也不复制校验器。

v2 材料 `structured_review`／`independent_review` 当前均 pending；旧审查仅归档为历史，不借其 passed 为本版签名。显式 v2 校验只核当前材料结构与绑定，额外返回 `review_pending=true` 和 `execution_ready=false`。Root 实际独审后才更新审核状态和固定绑定；未来真实入口须另外接合同，本次不接 `evaluation_ecnu`、phased audit、runtime 或执行守卫。

## Testing Decisions

使用 tdd，在相同公共 validator Interface 上逐个红→绿切片：

1. 封闭版本选择和默认 legacy 行为兼容。
2. 新 public21 结构绑定及 A05 源角色／未知归属约定；无关窗口、输入、来源选择与分母不变。
3. full140 新 parent 文件／对象／annotation 绑定、首21完全一致、原140映射与新增119不变。
4. 跨版、任意路径、错摘要、伪复审状态、输入／target／分母／源选择破坏均拒绝；即使调用者重算参考摘要，也不能跳过固定路径和 parent 合同。真实pending v2直接进入旧packet入口继续拒绝；纯结构函数不授执行资格，缺／多顶层键、布尔位置、命题／分支缺字段、重复ID等仍拒绝。

最小相关测试为 `tests.unit.memory_extraction.test_evaluation_reference`，兼容组包括 `test_evaluation_review`、`test_evaluation_phased_audit` 及现有离线执行入口测试；只合成，无凭据、模型、PG、GUI 或安装。完成后报告真实测试命令／计数和静态范围核对；独立审查由 Root 组织，不在本稿预标通过。

## Out of Scope

旧参考／旧判据／旧成绩／旧票／原输入、评分口径、生产 grounded-v2、v4 编译器及 ADR-059、typed proof 扩展、业务迁移、真实 full140 入口、模型请求与预算均不在本切片。默认空放行表、原三门、相关维度合取与逐类批准保持；新参考不能回写旧账或把局部成绩拼成完整质量。

## 实际验证

Root将无交集的v4提交接入主树后，最终在`965a4a73`工作树验证，未重置HEAD或触碰索引。本切片共9文件：本spec、四份新参考／判据、`evaluation_reference.py`／`evaluation_review.py`及二者unit测试；没有修改任何旧参考、旧判据、原输入、其它运行入口或初始dirty。

TDD实际过程：封闭版本选择先因不存在keyword失败，再绿；public v2先被旧绑定拒绝。首次public green尝试又暴露旧审核器九键／已审状态的耦合，尚未通过，日志保留为`desktop/artifacts/reference-v2-green-public-20261016.log`；Root据此批准最小纯结构Seam拆分，未采用假已审视图。新纯函数先因ImportError真红，再与pending正负控及public切片转绿；full v2先因不存在keyword真红，再通过新parent正控。相关red／green／controls日志位于`desktop/artifacts/reference-v2-*-20261016.log`，不把失败尝试计作通过。

最终检查（Python命令均先激活`NotAlone`，关闭dotenv并使用`-B`；工作目录`backend/`）：

```sh
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 python -B -m unittest discover -s tests/unit/memory_extraction -t . -v
NOTALONE_DISABLE_DOTENV=1 python -B -m unittest tests.integration.memory_extraction.test_evaluation_ecnu tests.integration.memory_extraction.test_evaluation_offline -v
NOTALONE_DISABLE_DOTENV=1 python -B -m mypy src/notalone/memory_extraction/evaluation_reference.py src/notalone/memory_extraction/evaluation_review.py
```

- 完整memory_extraction unit：**479/479**，6.128秒；最终日志`desktop/artifacts/reference-v2-final-unit-v3-20261016.log`。
- 现有ECNU／offline入口兼容测试：**97/97**，19.470秒；纯Mock，无真实调用；最终日志`desktop/artifacts/reference-v2-final-integration-v3-20261016.log`。
- 两源码mypy：通过，日志`desktop/artifacts/reference-v2-final-types-v3-20261016.log`。唯一测试总数为**576**；早先reference／review／phased最小组**65/65**已包含在479中，不重复累加。v3日志后缀只指最后一次离线核对，不改变本版source-fidelity-v2命名；前两次同组通过后仅澄清继承历史的元数据并更新固定摘要，故作最终重核，不累加测试数。
- `git diff --check`通过；三份新Markdown的173个本地链接均可达，无本机身份绝对路径，空白／换行检查通过。
- 四份旧材料实际字节与固定历史摘要一致。新21只有A05窗口改变；新140新增119逐值、R105、完整来源档案、oracle、映射及全部输入摘要保持。分母与分支／来源选择仍分别为21窗28＋1／34／40、140窗138＋1／156／162。

| 新材料 | JSON规范SHA | JSON文件SHA | 中文字节SHA |
| --- | --- | --- | --- |
| public21 v2 | `d4b6b2de9f23a442af6f2ef49d22e09911446c00bc46436eb940c71cad102091` | `10a9e6ff5222c9c7a2b9776584fd560bc7344853c56becd77c7646bd65191d48` | `08ef4653f776ee1b998715eedc3bbe7f3887fe991b7e4ada2fc6041b95ee65e1` |
| full140 v2 | `f79ba7ef8b32e7d6ff47df55d724ddf6e3c8dd4c9eae17aac9b7161fcee19d2e` | `01e3b2c79ef03b28053ad234586940a93f705231d5a4062ce99e0005b0baaf92` | `d90a49ba22d65eeb61b25f518b9045eac5866fafd627d9863c683c47f6fb8c95` |

实现者交付时仅结构已验证：`review_pending=true`、`execution_ready=false`、`quality_certified=false`，独立审查没有预标通过；随后实际两轴结果见下方Answer。没有真实模型、预算／凭据、PG、GUI、安装、业务写入或旧成绩重算。后续真实入口和相应固定绑定另接。

## Answer

Root已另行组织独立Standards和Spec审查：Standards硬规则0／判断性问题0；Spec缺失／错实现／范围外0。Spec审查者独立核对了实际合成源、contact sender／target 0、输入摘要和D2第87行，确认姐姐出借、联系人接收及已发生经历保留，产权和“她”的指称仍未知。此次语义审查只覆盖A05及直接通则修订，完整140核装配和不变性；其余语义延续旧独审，非新盲标、现实真伪或模型质量认证。

物品归属v4修订集成主树后，Root实际运行reference／review／phased与两个v4模块的组合回归，**86/86**，5.514秒，日志`desktop/artifacts/reference-v2-object-integrated-20261016.log`；这是重叠的集成复核，不与576相加为唯一测试数。相同Conda及禁dotenv环境，命令为`python -B -m unittest tests.unit.memory_extraction.test_evaluation_reference tests.unit.memory_extraction.test_evaluation_review tests.unit.memory_extraction.test_evaluation_phased_audit tests.unit.memory_extraction.test_grounded_v4 tests.unit.memory_extraction.test_grounded_v4_runtime -v`。

材料在本切片仍保留真实pending状态与上述固定摘要；没有为通过旧packet门构造假已审视图。resolved表示9文件切片完成。后继若记录已完成的独审并接执行资格，须另行明确更新元数据、规范／中文／parent固定摘要及入口守卫，不借此历史摘要冒充新冻结。

# 05：生成可追溯的基础候选

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 04
Spec: ../spec.md

## 交付行为

从本地检索到模型、引用校验、落库和桌面展示；验证检索模型显式准备、embedding／分词／排序兼容，以及预算、记账、时限、跨新旧实现的前台优先与取消。

规格：[精简 DSH 与 TS 后端迁移](../spec.md)。前置任务：[04](../issues/04-contact-context.md)。

## 验收条件

- [x] 完成本票下方 DSH 查证要求，记录版本、官方文档／源码／示例依据与适配理由；无直接接口时记录边界核对结论，未查证不得宣称完成。
- [x] 从桌面生成入口贯通同联系人检索、模型、候选结构与引用校验、幂等保存及展示；无数据、坏引用、失败和重复请求均保持原合同。
- [x] 切换前验证本地检索模型的显式准备、旧向量读取、embedding／分词／排序兼容；运行时不隐式下载或外发 embedding，不隐藏调用旧 Python 检索。
- [x] 逐次物理模型请求核验输入版本、出站范围、预算、调用数、时限和实际费用记录；取消或删除后晚结果不保存，真实调用仍按规则记账。
- [x] TS 前台与旧 Python 后台共存时，有可验证的统一仲裁或既有暂停／恢复机制，保持前台优先及总并发；两边各自限流不能算通过。
- [x] 证明新旧责任交接与回退不会重复生成或丢失用户修改；模型返回后不增加语义复核调用，不提供外部发送工具。

## 验证

复用回复公开业务合同、本地检索对照和模型预算／优先级测试；增加新旧后台共存的物理请求仲裁及晚结果验证。 优先经已确认的 HTTP／事件业务入口和桌面控制器检查持久状态及用户可见结果，必要时补充模型／任务接口与宿主生命周期检查，不依赖框架私有内部结构。

## 执行前必须核对 DSH

- 先阅读本票涉及的**锁定版本** DSH 官方文档、相关源码和示例，核对现有 NotAlone 实现；不能凭印象猜 API、配置、依赖或生命周期。尚未锁定版本的01／02先记录候选版本并由02固化。
- 在本票记录版本／commit、具体来源链接或源码位置、核验结论及本次适配理由。官方说明只证明约定，仍需实际测试；不得用可变 master 文档冒充锁定版本证据。
- 优先官方插件、公开接口和已有机制；不胡乱重写框架能力、绕过官方 profile、臆造配置或擅改 DSH 核心。能力缺口须有最小复现或源码依据，影响已确认方案时先报告冲突，不自行换路线。
- 纯业务改动也先判断与 DSH 的交互和生命周期影响；确实无直接依赖时明确记录“不涉及直接接口”及依据，不为完成阅读要求无关重构。

## 工作边界

- 实现与验收已按本票原六条完成。按已确认[规格](../spec.md)及[规划索引](../planning.md)核对前置票实际验收和现有代码，未通过前置不能开始依赖实现。
- 业务始终按 owner_id + contact_id 隔离，来源、权限、预算及删除随本票一起验证；确定性流程由业务代码控制，模型没有外部聊天发送能力。
- 新旧实现每项业务只有一个执行和写入责任方；回退先核验结构和在途任务，保留新增／编辑／删除决定，不恢复旧库或自动逐请求兜底。
- 日常开发先核验并复用 npm run dev 实例，不打包、不运行打包版；本票不授权发送外部消息或扩大真实资料范围。合成验证、真实模型及实际 App／微信证据分开记录。
- 先运行最小相关验证；仅提交本票变更的本地提交，不 push。若范围超过一上下文，先记录完整行为切片与依赖调整，不降低验收要求或任意扩大本票。

## Comments

2026-10-23：用户已认可任务拆分、依赖和验收入口并要求逐张发布；补充明确要求实施前必须看 DSH，不凭猜测乱改。任务保持 open。

## Answer

已按原六条验收条件完成本票。DSH 固定 `0.2.1-rc.2`／官方 SHA `687f282e8625c6b8d11ff58211a90524be2e4317`；使用锁定的官方 profile、Agent／Tool／LLM 公开机制，确定性来源校验、预算与保存由业务代码负责，没有修改 DSH 核心。[查证来源与适配边界](../reply-generation/reply-remaining-business-acceptance/evidence-gap.json)保留官方文档／源码位置及无 `.git` 归档的版本关联边界。

| 原条件 | 实际证据与结果 |
| --- | --- |
| 1. DSH 查证 | 已记录锁定版本、官方 SHA、相关源码和适配理由；实际官方 runtime／SDK 验证与静态查证分开记录。 |
| 2. 桌面完整回复链 | [B5-01 接收](../reply-background-root-acceptance/accepted-manifest.json)贯通生产公开 prepare→status→replies、同联系人非空背景、官方 wire、候选／引用校验、幂等与 PG 复读；[实际开发 App](../reply-app-acceptance/actual-app-v3-result.json)显示聊天1／关系2／当前输入2项依据，未确认参考显式标注，候选可编辑保存，甲→乙无候选→甲保留编辑。无数据、坏引用、失败和重放沿用已接收公开／持久合同。 |
| 3. 本地检索准备与兼容 | [显式准备](../reply-generation/retrieval-validation.md)与[冻结兼容结果](../reply-generation/retrieval-frozen-results.json)：327/327召回，420/420 token／mask／向量及排序；固定公开权重、缺模型明确失败，无运行时隐式下载／外发 embedding。旧回复为词法、BGE用于记忆召回，没有旧持久向量表需迁移，不隐藏调用旧 Python 检索。 |
| 4. 物理请求、预算与迟到拒存 | 已接收输入版本、出站范围、全请求预算／计次／时限及真实费用未知值合同；[真实供应商最小两臂](../reply-generation/reply-vendor-first-pilot/root-actual-result.json)实发2次，费用未知保持null。B5-01来源失效晚响应409／0候选且真实调用仍记账。App另观察本机HTTP3：正常1条http_accepted/succeeded，取消2条authorized_unconfirmed/cancelled且用量费用未知；provider收到请求不等于客户端收到响应头，不伪造为0或已确认。 |
| 5. 新旧统一仲裁 | [B5-02 正式接收](../reply-business-root-acceptance/accepted-manifest-v2.json)：同一Host下实际Python后台SDK与TS前台竞争，B2先排队、TS后入队，实发B1→TS→B2，总并发1；逐次PG预约／receipt／010／live journal按permit_id关联。 |
| 6. 交接、回退与用户控制 | [B5-03 正式接收](../reply-business-root-acceptance/accepted-manifest-v2.json)：同兼容库TS→Python→TS正常重启，原UUID、用户编辑、显选版本及删除决定保留，复读／重启新增模型HTTP0。模型返回后无新增语义复核，未提供外部聊天发送工具；复制提示不冒充后端selection写入。 |

实际 App 先发生一次受控自然超时，原编辑未被覆盖；随后确认第3个本机请求已开始且PG为running，经界面删除生成中的助手会话，再释放迟到响应并刷新，派生五表为0，独立聊天来源／关系记忆保留。实际界面没有单独取消按钮，删除触发的取消与独立取消接口分开记录，普通联系人切换不取消。首次省Python／项目路径被真实启动诊断拒绝，后经UI补齐已安装路径后诊断通过并认证复用同一Host／Legacy；不宣称省路径可接入。

最小正式验证：B5-02/03为2/2、本机HTTP5；B5-01为1/1、本机HTTP2；v3清理顺序7/7，均exit0、0skip。既有[基础双轴](../reply-generation/reply-post-review.md)、[业务Spec](../reply-generation/reply-business-proofs-spec-review/report.md)、[仲裁清理Standards](../reply-generation/reply-business-proofs-standards-review/delta-review.md)及[背景清理v3复核](../reply-generation/reply-business-proofs-standards-review/b501-v3-delta-review.md)覆盖相应源码，确认问题已处理，窄增量finding0；P3检查表达式仅review-only，原冻结打包历史未改写。仅复用已接收组件结果，未重复SDK／App／全253矩阵。

已本地提交 `8dc8623d`（来源接线）、`ca94d34f`（仲裁／同库回退）和 `431a5d4d`（背景业务／实际App），两份末次接收清单引用SHA匹配，提交前后公开隐私扫描均exit0／issues0。实际App经菜单正常退出，独占进程、合成库及临时目录均已清理，共享PG保持存活。测试只使用公开合成资料；真实供应商仅原授权两次，无微信发送、打包或push，未混入其他票变更。

用户已撤销近期聊天独立8k限制，保留最多50条及完整请求总预算，见[原决策](../recent-window-limit-removal/decision.md)。默认真实用户回复仍走Python，`quality/switch=false`；完整96对照、质量／费用／性能门槛及默认切换仍归25及后续票，原计划和历史失败／unknown证据均保留。

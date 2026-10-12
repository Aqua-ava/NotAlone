# ECNU评测接线与发送前门的受限实施规格（2026-10-12）

> 原票：[指代07](../memory-extraction-accuracy/issues/07-reference-resolution.md)。基点`bf400c99`。新增功能冻结，OCR暂停；本片只做评测工具，真实调用仍关闭，42／84尚未激活，旧预算不复开。

## 问题与范围

[已验P0](memory-offline-records-result-20261012.md)只允许假端点Mock。[接线核对](memory-ecnu-driver-readiness-20261012.md)发现真实入口仍缺期限、最终请求漂移、源码冻结和成功响应型号观测门。用户已明确A14“一次性等下发地址”不存成关系资料；不再要求其填写技术标签。其余逐命题技术判据仍须独立复核、完整冻结，不能凭工具可运行就启动基线。

本片完成独立ECNU评测入口和发送前门，全部以精确Mock及假凭据加载器验证；不读真实密钥、`.env`、私人结果、业务库或聊天，不启动App／微信／CLI，不修改产品prompt、schema、用例、原matcher、默认采纳或放行。

## Implementation Decisions

1. 保持P0入口仅允许Mock。另提供`run_ecnu_evaluation`，内置公开16条reference＋3补充＋2核心、原顺序与21窗分母，P1最多42次实际HTTP尝试，串行，不自动执行P2。数据只有既有公开合成输入，使用[已确认ECNU路线](ecnu-model-config-20261012.md)。
2. 凭据只由显式`credential_loader`运行时一次提供，不设环境、官方供应商或工具fallback；先核对Gold状态／计划／来源文件与冻结摘要，再加载。同步／异步HTTP客户端都显式接同一预算、记录器与contract，禁止默认SDK网络旁路；沿原temperature0、timeout60、max_retries2、thinking enabled、stream false、effort省略。
3. 新`ECNUEvaluationContract`只有期望请求上下文、请求核对和响应观测三个动作。期望体只含固定请求参数、原E/V工具、具名选择及原adapter消息；发前核对canonical整body、精确端点、时区明确的截止、绑定源码摘要。未绑定、到期、漂移或源码变化用`EvaluationBudgetAbort`停批，不被SDK重试捕获后继续。
4. 允许响应先私有保存，再判断型号观测。只有结构合法的成功Chat Completion参加基准，首个字符串或缺失观测为基准；后续变化停止。429／5xx／TransportError独立记录并计预算，不建立型号基准，保留原重试。型号一致只证明报告字段一致；缺失不得认证权重身份或生产放行。
5. 复用已有记录／E/V／原评分／21位置状态／双客户端清理／真正关闭收据协议；最小共享辅助可以重构，但P0公开行为须回归不变。最终配置白名单显式扩充stage、deadline、源码／Gold摘要、工具选择、无fallback与响应观测规则；不允许任意敏感字段进入配置。
6. 本轮完整判据与旧matcher分开。每个窗口保存原输出、原matcher结果后，由**必需**的`audit_case`回调返回严格的`safe/general_error/safety_error/unknown`，绑定该位置与冻结判据摘要。回调无默认safe；无效、未知、安全失败都停，全部已预约失败和未运行位置保留。允许将已预注册的正确日期／同义等差异与旧matcher安全标签分开，但不改旧成绩、不掩盖真正坏auto。审计先保存再继续，结果始终`quality_certified=False`。
7. 冻结材料至少包含21窗顺序、全部input／target、逐命题判据与等价边界、E/V prompt/schema与构造代码、Flow／语用／评分／预算／记录／driver、实际依赖版本、接收端与参数、省略项、停止／关闭条件。Gold状态和摘要只是运行材料引用；工具不得自认证实际语义判据已经正确。

## Testing Decisions 与Seam

- 原HTTP transport Seam：同／异步发送前停止及计数，响应保存后才进入身份门。以精确Mock观察实际dispatch次数，不mock内部私有方法；外层拒绝默认HTTPX／HTTPX2 transport、socket和DNS。
- Contract Seam：显式绑定请求→dispatch→允许响应观测。逐片验证到期、body／source漂移、未绑定、源路径逃逸、成功字段变化停、可重试错误不改变基准。
- Driver Seam：21窗固定计划、冻结无效先于假凭据加载、双侧SDK与具名E/V最终序列化、合法空E跳过V、真实attempt重试封顶、必需独审失败停、旧matcher与独审差异分报、记录／清理故障不签收据。所有输入／响应均合成，假凭据不记录。
- 使用TDD单片red→green，相关组验证后Standards／Spec两轴独审，本地任务专属提交。上一阶段172／172不能算本片结果；没有真实调用就不称ECNU工具组合或模型质量通过。

## Out of Scope

真实供应商执行、P2或新对照、产品行为／新字段／迁移、自动采纳放行、真实聊天上传、环境凭据检查、OCR／App启动、调度／Agent Harness／外部消息发送。实现和代码审查完成后仍须单独核对完整技术Gold与实际冻结材料；沿用户已有授权继续必要准备，不重复询问执行权限。

## 工作分工与记录

传输门worker拥有新contract、budget／records受限接入及相应unit测试；driver worker拥有新ECNU入口、P0共享辅助与integration测试；技术标注worker只处理其已有标注文档。主Agent负责规格、实际答复记录、最终集成检查、双轴review与本地提交。所有worker共享仓库，不回滚或提交别人的改动，禁止自行访问真实供应商和桌面。

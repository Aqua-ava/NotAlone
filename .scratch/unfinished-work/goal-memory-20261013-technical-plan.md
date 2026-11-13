# 持续目标：新预算索引与ECNU技术探针预注册

## 执行范围

本片承接[记忆诊断与工具修复](goal-memory-20261013-diagnosis.md)，用户已允许使用根`.env`现有ECNU配置与密钥。主Agent限定目标新总包480次，记忆片新总硬上限466次，另14次未启用；本计划不授予其他供应商、真实聊天、产品默认放行或旧预算恢复能力。

先执行6个公开合成技术探针，技术契约可用后才建立当前21窗语义基线。技术200仅证明该固定请求取得合法Completion，不是记忆质量；T6的允许输出私有保存，不冒称原16窗基线、核心同批或自动采纳证据。

## 固定总额度

| 阶段 | 唯一新run ID | 真实HTTP硬上限 | 触发门 |
| --- | --- | ---: | --- |
| technical | ac04d687-248f-4050-9671-c8ccd20d9278 | 6 | 本片6payload、源码、桥与期限完整冻结，Root核验 |
| baseline | 058fa1c2-d34c-41c5-9cbb-780e74bdd5eb | 42 | technical全部可用，再冻结21窗与既有raw/full审核 |
| reverse | ae0add54-7f6e-4033-b1e6-37e3a400748f | 42 | 基线完整、无安全错误且有相关一般错误，固定反序复现；没有信号则不运行 |
| comparison | c02248b0-ad08-4d09-9fb7-edf21539081a | 96 | 失败已稳定复现，另冻唯一最小候选与最多12既有公开窗×2臂×2重复 |
| full_regression | 88a79693-5c3c-46f3-9cd9-53f18465c428 | 280 | 候选有严格收益、无安全/正例损失，再冻140公开窗完整语义判据 |

上限和466。每个run沿已有`EvaluationBudget`用户级0600 SQLite，在每次transport发送前持久预约，SDK重试也占用本阶段同一额度。每个run只领取一次，领取/关闭后拒绝重开，不换UUID补位；关闭后的余额不能挪用或重新分配。唯一索引先以0600独占落盘并fsync；实际总计数由索引列出的5个SQLite预约数求和，未运行阶段单独记录unrun。后续阶段只有额度预登记，尚无样本/候选执行授权冻结，不能自动启动。

## technical六个固定payload

所有请求精确`POST https://chat.ecnu.edu.cn/open/api/v1/chat/completions`、`ecnu-max`、temperature0、stream false、timeout60秒、transport retries0，直接HTTP没有SDK补发、供应商或工具fallback。T1–T5只使用无人物/业务资料的中性合成提示；T6只使用现有公开reference第一窗。每步相对前一步只改变一个逻辑因子。

| 顺序 | 唯一差异与观察 | 规范payload SHA-256 |
| --- | --- | --- |
| T01 | 极短公开system/user＋model/temperature/stream，先验证最小连通 | 65c15e8cf9a6d77395affdd077873d2c0e3d95f65ef43eea6650217232112329 |
| T02 | 只加入thinking enabled，effort继续省略，不假定实际档位 | f54dad0837bcec781f5431e1083086b61975d0bc46058a6e3da0fbb878ae7344 |
| T03 | 只加入最小MemoryExtractionOutput工具，保持中性提示；此步不要求自动选择工具 | d3c5f16734edba12aabd8ae6f092a92e95e5514f3ba56370a4b4f73a4dada783 |
| T04 | 只加入具名tool_choice，必须返回唯一同名工具和facts数组 | 84682d6a2aed26f7d0265e4bcf1cfb825e5d144e22147a3f75494c00bbae0e4e |
| T05 | 只将工具schema替换为原生产E完整schema，工具名和choice不变 | 52efb6de4b678ae8210affcbb343da9e6b95c9a7ef786449b9a0dd882bcec03b |
| T06 | 只替换messages为当前首reference窗原生产E输入；不是一次全量基线 | 9dae754df11b5ee54bceb49c7a4b56de82f4e8547b85c7219d6206c80696c789 |

前次固定7键生产请求与ECNU官方表的差异是具名tool_choice组合没有官方保证；不是已证明的500根因。官方表支持thinking、tools和temperature范围，思考下temperature可能被限制。各步骤用于区分基本服务失败、思考组合、工具选择、schema和长提示/窗口；只作请求因子归因，不给服务部署、权重或凭据作过度认证。

停止条件：任一HTTP非200、非JSON/无法安全脱敏、非法Completion、已报告model字符串漂移、T04–T06未返回合法具名facts工具、期限或源码/桥漂移、计数/落盘/收尾失败，立即停止该run；之后位置保留unrun，当前无法确定时记unknown。不能安全解析的正文只保留摘要与缺口，内部思考和headers不保存/回显。收据只有durable closed、完整分母和HTTP事件对账均成立才可用；收据中的plan_complete和quality_certified分开，后者始终false。

## 当前冻结与工具验证

- 仓库源提交：`629618ba88faeb6e7c267ebaad0e6fdbc73cfe50`。只冻结59份必要记忆/依赖源码、包配置及既有公开Gold JSON/中文参考，逐文件与该提交blob相同；并行桌面主题不加入模型材料。
- 唯一工作目录：`/private/tmp/notalone-memory-goal-20261013-ac04d687/`，0700；`probe_run.py`、`probe_selftest.py`、`probe-plan-v3.json`、`goal-budget-index-v3.json`为0600。prepare只生成材料，不创建可用真实client、加载密钥或领取模型预算。
- 截止：台北2026-10-13 02:15:00，UTC2026-10-12 18:15:00。到期不能通过换UUID/路径恢复。后续阶段各自再固定有限期限，仍须落在目标总包内。
- 当前v3桥SHA：`6b92f5a4a0277122e061d36ef4f545b886450fa142ea84ca98379e41e1b4e0a7`；自检SHA：`82b5fea2f48be6b5703c30bf5a33d80fa7fe4fc242123735e986e74c807e80f4`；规范bundle SHA：`e1ecc30761c7afd07e48ec0dbf41078ef49931a2166b94ed216c42e0acb5840b`。
- 6项外部桥自检初次全绿，0.083秒：全6个Mock计数/闭账、不透明500单次/unknown1/unrun5及收据、JSON错误停后续、具名工具缺失不能冒称成功、源码变动停第二发、只读取假.env3个约定键及重复拒绝。自检禁止HTTPX/HTTPX2默认transport、socket及DNS，自有临时home和目录均退场；无真实密钥/HTTP/App/业务资料。
- 最初mypy有7项外部源码路径未映射和2项临时变量字典类型错误，保留此失败；设置项目MYPYPATH=src并区分case_result/final_result后，单桥mypy通过，不靠ignore或修改产品类型。首准备v1和预审v2保留，均未运行或领取，不覆盖首材料；v3才是本次待执行冻结。原v2桥SHA为92f303bd…、bundle SHA为09914d4f…，只作历史。
- v2双轴预审发现main忽略失败摘要而exit0、facts:[1]可误算工具格式通过、store构造失败会遗留可重新打开预算、client收尾失败仍可得到完成收据。新增4个离线回归各实际红灯后，main只在六位置完成且无失败/未知/未运行/停止、收据可用时exit0；按本次固定JSON Schema递归核结构（含必填、数组项、枚举、nullable、数值范围）；创建store至client、预算关闭统一finally，收尾或事件不可核则拒收据。补正后共10/10自检，0.137秒；mypy第一次新增2项object数值/空tuple注解错误，修正后再次通过，失败均保留。没有降低语义门槛或增加发送。
- counter明确为reserved_requests和mock_mode；real_http_attempts_upper_bound在Mock为0、真实模式保留预约上界，不能把预约或Mock数当成已确认收到响应的网络dispatch。实际运行需另核provider_response/provider_failure及未知事件，所有预约仍消耗硬上限。

根`.env`只在持久batch领取后由显式loader读取，核普通/当前owner/0600；只提取3个约定ECNU键，配置不匹配、重复、空值或不支持的结构即拒绝。秘密值不写bundle、控制台或记录；不复制.env、不使用业务配置、不调用产品factory。

本片执行前真实HTTP0，旧预算全部关闭。v3已由既有Agent完成独立Standards与Spec双轴只读审查，均0项；Root已独立核对桥、bundle、59源、6payload、权限、5个唯一run及466上限，并授权仅激活technical一次。不会以准备、离线绿灯或技术Completion勾选原07/核心01/维度03的模型验收。

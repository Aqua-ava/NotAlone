# 实际共享模型宿主与物理调用接缝验证

2026-10-24。根在a7959d83之后整合已审21路径与13宿主路径、组织ACK最小修复及正式测试；默认仍Python，显式TS只作迁移验收入口。DSH固定0.2.1-rc.2／687f282e8625c6b8d11ff58211a90524be2e4317，无官方核心修改。

## 行为与数据

- 唯一稳定模型journal、原PG事务ledger、官方匿名ID与私有reply信道；PG恢复完成后才启动原Python队列。业务owner/contact不传入匿名身份接口。
- 原SDK逐次预约，传原call/ledger UUID与called_at；真实claim和原job额度由服务器反算，禁止客户端自报次数、隐藏SDK重试和逐请求回退。NULL本人范围不造联系人010。
- 恢复集合同时读取同一journal未知许可、实际孤儿许可和原trace ACK未知，认证分页只传身份元数据；已知PG终态不降级，未知消费不能自动重放旧批。
- 只接受原结果真正获ACK来清除该结果的未知状态，后续保守unknown清理ACK不能代签。真正unknown已确认时可正常释放物理许可。
- 清除trace正文后只凭原batch_key及同scope、同任务的原committed input关联恢复门禁，不重建正文，不补造处理目标。
- 停止先取消新工作，等待两侧真实SDK和Python退出；无法排空时保留journal未知并报错，不以断线或kill冒充结算。

## 主协调实际验证

- `node --test test/host-model-accounting.test.mjs` 9/9；`test/model-recovery-metadata.test.mjs` 4/4：PG范围NULL隔离、持scope锁时查询、鉴权、130条真实Python RPC分页。
- `test/model-organization-physical.test.mjs` 4/4：contact/owner完整400可作为已知失败重试；半正文未知不自动重试。
- `test/model-organization-ack.test.mjs` 12/12：四组终态ACK丢失、四组精确结果再确认、两组真正unknown、两组非shared兼容；原store/服务/Worker/SDK/PG/Unix均实际执行。
- 115项相关原Python测试通过，包括新增完整HTTP实体证据5项及模型control/reply接线。无模型启动门禁2/2、严格全项目TypeScript检查通过。
- 官方host profile合成恢复/私有回复纵切1/1；默认真实主宿主HTTP8/8。pnpm按精确lock安装完成供应链检查，无版本升级。
- 独立实际public→原Python→私有TS→官方provider本机SSE 1/1：幂等、request/010链接、联系人隔离、公共token拒私有、完整400不重试/回退及正常关闭。

## 独立故障复核与范围

- 组织ACK修复手工0finding及实际窄验3/3；提取SIGKILL+清正文的最终21路径/正式111三组3/3，另核对跨owner/contact与空link保守阻挡。
- 最终42路径/正式111的原学习store/Worker/SDK，200与400各1/1：旧批/显式resume不重放，新真实讨论批成功；第二次宿主重启仍由实际factory拒旧请求，原010/已知结果/NULL费用不改。
- 近额度独立PG/SDK窄验4组：服务器提取window上界跨claim不重置；原upgrade/layered job跨batch最后额度不重复消费；unknown仍阻重放；NULL本人/contact额度隔离。129为兼容上界，未声称默认完整提取流程能达到129次。
- 以上均为随机合成资料、本机PG及模拟HTTP/SSE，无真实模型或聊天资料。实际App默认无模型冒烟见后补记录；此记录不签完整后台路径、已退役upgrade公开入口、真实回复质量、最终所有权切换或全迁移完成。

可重跑正式Node命令在backend-ts执行；Python相关模块见正式测试目录。提交只含最终源码、正式测试和本记录，不含冻结副本、临时运行依赖或模型资料。

## 回退重放修复后的最终验证

真实组织任务在 TS 终态 ACK 丢失后切回 Python，再从公开服务暂停、继续，会重复同一任务的模型调用（HTTP 1→5）。现在 Python 模式启动先从与实际 ModelHost 共用算法得到的稳定 statePath 只读核验 journal：旧宿主存活或身份未知、active/unknown 非空、损坏或权限不可信时返回 reply_runtime_recovery_required，队列尚未启动。新库和正常结算后的回退仍允许，不创建模型资源、不清理 journal、不降级原 PG 已知结果。

- 根实际最小故障用例1/1；最终四模块42/42、0skip，包含共享 parser 的三项拒绝且保留原字节回归；全项目 TypeScript strict 通过。
- 合入后的实际 SDK/profile/公开链共14/14：12项组织 ACK 恢复、官方 profile1及实际主宿主 public→Python→私有TS→官方 provider 本机SSE1。后者再次核591份复制的原Python源码/迁移字节不变。
- 独立双轴复核规范0、规格0；另复核新增 parser3/3。此前独立真实稳定 ModelHost SDK3/3和正常 launcher 生命周期互斥1/1仍与最终三源哈希一致。
- 根再次以 npm run dev 和 Computer Use 验收默认无模型管理后台、设置/同步入口及菜单正常退出，八项数据计数0，隔离实例与测试资源独立清理复核0。记录见 ../model-host-dev-smoke/after-guard-validation.md。
- 最终上下文另以原冻结28case材料，先50条两臂最小2/2，再单次28×3×2=168/168：UUID/顺序/原文/来源/作者/微秒和投影一致，无模型调用；此结果不能代签生成质量、完整请求预算或默认全部关系资料召回。

该回退门禁限定正常 DSH launcher 的同一稳定路径；旧顶层 Python 入口、移动路径、同库多命名空间和24完整回退仍需专门验收。默认仍Python，显式TS不构成最终迁移切换。正式源/测试精确范围见 final-manifest.json；没有新增迁移、外部调用、正文留存或聊天发送能力。

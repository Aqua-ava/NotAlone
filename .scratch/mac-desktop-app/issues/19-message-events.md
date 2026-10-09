# 19：新消息事件与编辑保护

Type: task
State: claimed
Triage: ready-for-agent
Blocked by: 11, 12
Spec: ../spec.md

## 交付行为

接入真实 SSE 消息通知，提示上下文更新，由用户决定刷新或重新生成，保持正在编辑的候选。

覆盖规格用户故事：31。

## 验收条件

- [ ] 新消息提示属于当前 owner/contact，断线、换连接或切换联系人后旧事件失效。
- [ ] 用户主动刷新不会静默覆盖已有编辑；重新生成形成新请求，旧候选继续对应原依据快照。
- [ ] 使用真实本机 HTTP/SSE 与隔离数据验证更新、恢复和竞态，不无限扫描历史。

## 测试与范围

- 沿用规格中用户已确认的实际 App 操作与后端 HTTP 公共接缝；一次推进一个 red -> green 行为，自动验收与实现一起完成。
- 涉及业务数据时只使用合成资料、随机隔离 `_test` 库和独立握手/配置；本任务未涉及的后端、渠道与桌面能力保持后续任务范围。
- 按仓库工作流读取相关领域及工程约束，完成最小相关检查、Standards/Spec 两轴评审和只含本任务改动的本地提交。
- 不提交私人资料或凭据，不发送外部聊天消息；远端 Git 操作需另有用户明确同意。

## Comments

- 2026-10-08：用户认可二十张任务的粒度和依赖，按 `to-tickets` 发布；尚未开始本任务。

- 2026-10-09：接续19，先静态准备真实SSE公开页面red及认证回环传输方案；当前唯一运行权由root分配给其他票据，不启动PG/HTTP/browser/App。事件只提示当前已确认联系人上下文变化，主动刷新保留编辑，禁止自动生成及发送。保持claimed且无Answer。

- 2026-10-09：首片公开页面场景静态就绪，复用生产装配与EventBus，通过真实认证SSE提示新消息；夹具仅插入固定合成PG消息并发布生产事件。预期用户显式刷新后保留编辑和原请求依据，外部模型调用不增加。仅执行TypeScript typecheck、Python AST及diff空白检查，尚未运行场景，不宣称red/green或原生App通过；共享登记由root串行处理。

- 2026-10-09：首轮a1ed36f实际exit2，尚未进入候选生成编辑断言，属于夹具启动失败且cleanup未确认，不能记为产品red。纯import及合成模型构造确认importlib模块未登记导致Pydantic延迟注解无法解析；修复模块登记，并为ready前失败保留精确DB归属和异常文件。旧日志19-first-red保留；headless租约由root核验处理，未确认前停止新运行。静态模型构造通过，未调用setUpClass/后端/模型外部接口。

- 2026-10-09：root只读pg_catalog核验所有可能本轮随机core_flow测试库count=0，未DROP任何库，首轮精确库名不可恢复仍保留事实。补充CoreBusinessFlowFixture默认None的私有归属路径，19指定独立0600文件，随机dbname生成后、任何PG连接/CREATE前以O_EXCL/O_NOFOLLOW写入并flush/fsync；planned归属、finally清理确认及异常分开保存。AST/typecheck/diff通过，尚未开始下一轮运行。

- 2026-10-09：source0d625a4真正首public red在候选已生成/编辑及原依据GET200后缺连接提醒而失败，exit1/cleanuptrue。sourcee9cb741首片1/1green；此前22d68c7尝试因radio.check即时断言不适配异步桥接而失败，改为公开click+checked等待，不改产品。
- 2026-10-09：sourcefce463c真实订阅close后提示未转中断，actual red且cleanuptrue；实际HTTP缺结束响应导致keep-alive等待，ebd2a70最小修复SSE结束连接，用户具名重连并明确核对遗漏。2/2公开场景green。认证和帧不进入renderer，消息归属沿当前联系人limit20真实投影核验；无自动刷新、生成或无限历史扫描。
- 2026-10-09：source7eb602a五场实际green，exit0/cleanuptrue/Chrome1，quiet30 active0/window0，32 captured identities及自有groups无存活；12个历轮归属manifest精确库名只读核验均不存在，两leases absent。包含他owner/contact和foreign message ID、联系人/实际认证连接迟到失效、重连严格scope/字段/manager角色拒绝、新request保留旧GET依据。fe67982前一尝试因新增代理未flush真实响应头而5s等待失败，已仅修fixture并保留真实记录。
- 2026-10-09：新增真实HTTP EOF最小回归1/1通过（Conda、显式本工作树PYTHONPATH），不访问PG、不运行App。首次命令遗漏PYTHONPATH导入原仓库editable源而超时，独立attempt1保留，不记作当前候选失败或产品red。证据在context19-*；待合入最新main后最小复核与两轴评审，保持claimed且无Answer。依照WHATWG SSE解析约定和Node25.2.1官方http文档核对，无新依赖或安装。

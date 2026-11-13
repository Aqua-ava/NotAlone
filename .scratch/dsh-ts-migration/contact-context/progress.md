# 04 联系人上下文迁移

状态：实现、回归及双轴审查完成。基点 `9f39d6c2`，业务基线 `3c168296e9e8edaa43b8b323ff693e790e709069`；独立合同审计已消费，不修改审计文件。

## 固定官方依据

DSH `0.2.1-rc.2`，commit `687f282e8625c6b8d11ff58211a90524be2e4317`。实际查阅锁定导出的官方源码、CLI文档及minimal示例：

- [CLI公开启动/profile](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/README.md)：继续03的官方命名profile，不直接新建Context替换启动器。
- [profile-boot](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts)：44—64行ready通知；283—345行清理及boot完成后commit。业务先完成原结构与功能移交，再发布认证握手；框架ready不替代业务资格。
- [minimal示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml)：示例含日志上传、通用Shell和JSONL持久化，本票不增加这些服务或替换已锁定产品profile。
- 联系人SQL/DTO无直接DSH接口，普通TS业务模块由既有薄host插件装配；不新增模型工具，不以DSH session推断业务身份。node-postgres继续03已锁定8.16.3及原连接适配。

## 已确认范围

目录、消息、来源列表、关系概览及其投影写入、手动输入确认。回复证据、记忆修正、L2/L3生成、同步授权和删除执行仍由原具名业务实现负责。概览读取的动态证据验证是保留原返回合同所必需，不是提前迁移这些写流程。

原错误差异明确记录：未知/跨owner来源请求原为200空数组；合法但跨联系人的消息游标原为500。本票以404 contact_not_found、400 invalid_message_query区分身份/查询错误和合法空结果。未知概览联系人由统一范围校验返回404 contact_not_found（旧overview_not_found），状态保持404。无微信绑定不阻止用户查看已存手动资料；授权状态改变使捕获中的读取失效并要求重读。

## 实施及验证记录

- 开工 `npm run dev:status`：stopped、pids=[]。固定Node24，现有Conda npm；未读真实.env、真实数据库或微信。
- TDD公开HTTP：未知来源范围200→404失败后通过；消息读取未迁移404→保留原UUID/微秒/分页通过；公开旧start控制200→404失败后通过，显式来回切换保留原ID与修改；手动确认404→成功且不建渠道身份通过。
- Python门：具名停收/在途计数/排空/异常收尾，相关server单元136/136通过。此结果本身不证明PG投影和租约验收。
- 桌面：显式授权变化前后递增scopeRevision，保留人工选择及草稿；控制器27/27与类型检查通过。实际App证据见下方最终验证。
- 初期记录以外的完整验收见下方最终结果。

## 最终验证记录

- 固定Node24：`cd backend-ts && node node_modules/typescript/bin/tsc --noEmit && node --test test/*.test.mjs`：66/66；240秒有界执行，约35秒。
- `cd desktop && npm test`：952通过、1跳过、0失败；300秒有界执行，约53秒。控制器27/27及类型检查另通过。
- Python server单元137/137；dimensions/proxy组合4/4，公开prepare暂停TS响应时，Python stop/status在3秒内返回，释放后正常完成；没有模型调用。
- HTTP联系人12/12：原UUID、微秒分页、跨范围错误、手动确认、无绑定读取、授权/删除失效、双向移交、未知结构停收及内部代理认证。投影写入暂停后改变授权，旧请求409、投影数0；重读成功。
- 合成PG差分覆盖非空手工资料、冻结引用、来源失效、版本及可撤销性、事件、有限语义、v1/v2全文证明，保留Unicode键排序、浮点/大整数摘要和微秒。
- 实际 `npm run dev` + CDP验收5/5，见 `desktop/result.json` 及截图：同名原ID、消息及来源、空联系人、切换拒绝旧范围提交、重启保留原ID和107条迁移账本校验和。环境没有Computer Use，以实际App的CDP操作验证。

## 责任边界与数据影响

- TS负责五类联系人入口与关系概览投影。旧回复独立读取通过回环、独立令牌、owner校验代理到TS；公开令牌不能启动旧入口，内部令牌不能操作移交。
- 已持有旧事务的revision复核继续本地计算，TS接管时禁止contact投影写入；owner投影仍归旧业务。移交排空TS请求及旧本地writer，并校验原结构和contact→owner事务锁，不抢占其他任务租约。远程代理计入TS在途，避免相互等待。
- 显式回退先停收、排空、核对；失败保持停收，不自动兜底。旧prepare的200+overview_read_failed失败合同保留。
- 只用独立合成PG、匿名夹具和临时配置；没有读取真实.env/私聊/微信、调用真实模型、原始视觉帧持久化、Schema迁移或外发。合成进程、数据库和配置清理，开发App停止。
- 后续票共享接入点：host-plugin.ts、ContactContext、readContactOverview。05/06/09/18仍需各自迁移；本票不修改规划、执行索引和独立合同审计。

## 双轴审查

- Standards：发现一个缺失消息时间触发概览异常的P2回归，要求保留旧合同的未知时间；已补合成PG与Python差分，RED复现BigInt(NaN)，空值守卫后GREEN；相关模块2/2及类型检查通过，未知时间与旧实现一致。
- Spec：独立只读审查未发现实质性偏离；核对范围隔离、在途失效、唯一投影写入方及显式回退。
- 首次实现提交 `f4acc05d`。最终记录提交前再次执行公开历史检查；不推送。

公开历史检查：实现提交后扫描2143个历史commit、13977个blob及3597个当前文件，issues=0；最终提交后复扫。开发状态stopped、pids=[]。无push、打包或真实模型/微信验收；这些不作为本票合成范围的集成声明。

Standards独立复核确认空时间finding关闭，未发现新增问题；最终未解决finding：Standards 0，Spec 0。

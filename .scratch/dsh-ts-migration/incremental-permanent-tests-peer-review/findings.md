# 19永久回归候选独立审查

仅审两份冻结候选中的四个新测试/fixture/helper；未执行测试、语法检查、DB、HTTP、CLI或App，未改主树、index、票或原候选。工程规范与业务规格分别记录；本审查不重新签19状态。

## Standards

**1项P2：失败断言会阻断本轮隔离资源的teardown。**

位置：`incremental-stream-reconnect-test-promotion/draft/backend-ts/test/sync-incremental-reconnect-fixture.mjs:34–40`（拟正式路径`backend-ts/test/sync-incremental-reconnect-fixture.mjs`）。

`close()`先将运行结果缓存到`closed`，然后断言`host.terminate()===true`和PG业务连接数为0，成功后才`f.close()`。若断流/自然关闭回归恰好令任一断言失败，控制流不会到达`f.close()`；`t.after(close)`再次进入只取得同一个已拒绝Promise，自己的PG client、随机`_test`库及夹具目录不会再尝试释放。这会让永久故障回归在发现错误时留下隔离资源。该问题由控制流可直接确定，不需要假设真实环境或用成功日志证明失败路径。

依据：本次根审查明确要求全部自有process/DB/profile/socket清理；`docs/agents/engineering.md:46`要求独立测试数据与自有进程资源的归属核对/清理。未知归属保留现场的例外，不等于跳过已明确属于本轮的client及随机测试目录。`host-storage-fixture.mjs:10–12/23–29`证明这些资源为本轮独占；现有`f.close()`含`DROP ... FORCE`，不能简单把它提前使自然排空缺陷失去断言。

建议：保留原自然退出/连接排空断言及其失败结果，将已核身份的自有进程紧急收尾与独立夹具释放放入后续有界清理路径；缓存或抛出原错误，不能将失败改成PASS。无法核归属的资源继续明确保留现场。至少让受控失败断言之后仍尝试清理确定自有的client/目录/测试库，并报告清理未完成，而不是由缓存的reject永久短路。

其余工程项：`backend-ts/package.json:32`的`test/*.test.mjs`不会自动执行专属helper；新增文件只依赖现有`pg`、launcher、storage fixture及process-identity，无依赖/生产修改。合成数据、私有配置、无skip/todo和有界观测符合现有组织方式。

父丢失候选的`t.after`在失败时先以`processIdentityState==='same'`检查自有helper/DSH/Legacy身份，再公开关闭或发信号；归属/连接不能确认时明确报告保留现场（117–145），不会当作正常恢复PASS。未发现第二项确定阻碍。

## Spec

**业务与自动恢复合同0项阻碍；上方P2仍应在候选晋升前处理。**

- reconnect真实调用`launchDsh`→官方profile→当前host-plugin/Legacy；首流自然code7退出，外部fake CLI只提供合成输入，未stub业务、存储或clock。`reconnect.test.mjs:19/35–36`只有一次enable且无check/retry；33–34明确第二流使用`global-1-outside`，与`message-2/3`正文cursor分开；25–32要求故障前已有消息且实际观察故障/退避和恢复。
- parent-loss的SIGKILL目标是已核身份的真实launcher helper（87/190–191），不会先终止DSH/Legacy/CLI或清journal；192–201要求自然停读、旧锁保留、同配置重启回收。初始化的check在异常注入前（182），重启后只GET状态（202–206），不伪造自动恢复。
- 原UUID、绑定/baseline/cursor、原source/ref/processing和一次派生receipt在parent-loss的184/211–225逐项保留；合法新来源允许`message_reused`。reconnect核原范围/排除/baseline、稳定去重及范围外正文/历史读取为0。
- launcher白名单环境（`launch.ts:156–162`）只收候选显式配置，两个夹具均`NOTALONE_DISABLE_DOTENV=1`、合成owner及显式TS，无模型key；runtime必须unconfigured且模型任务/台账为0。私有HTTP为launcher写出的回环地址，PG为`/tmp`本轮随机库；DSH禁遥测、私有新profile，无外部模型/微信读取接口。
- 正常路径要求全部自有进程、CLI、info/锁/profile/socket以及测试库退出/移除；parent-loss另要求journal自然`host=null/active=[]/unknown=[]`。有界HTTP/启动/观测和90秒case timeout存在；没有skip、吞错PASS或以紧急cleanup充当自然恢复。
- helper与测试注释明确仅后端launcher父丢失；没有真实Electron故障、停机新消息追赶、20完整历史或整票19新增签收承诺。

固定官方依据：DSH`0.2.1-rc.2 / 687f282e8625c6b8d11ff58211a90524be2e4317`；`apps/cli/src/profile-boot.ts:283–308/323`的真实profile boot及disposer，`apps/cli/src/process-shutdown.ts:4–69`的有界signal清理。两用例通过现有launcher/profile公共入口，不新增/猜测DSH API或改核心。

本审查只证明上述静态控制流；作者旧PASS不作为本轮执行结果。根独占应用后运行两个最小case及收尾；不额外跑旧绿矩阵或实际App。

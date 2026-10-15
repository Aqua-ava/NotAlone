# 当前签名包单联系人总开关重开验收

日期：2026-10-16。范围由主Agent明确限定为同一App、同一后端内的总开关关闭后重新开启，不包含App／后端重启、第二联系人、来信或新增外部消息发送。桌面及真实CLI仅由主Agent执行；本文与测试准备不代表实机通过。

## 入口与现有缺口

现有`desktop/tests/real-sync-quit-acceptance.spec.ts`及`real-sync-visual-independence-acceptance.spec.ts`均只开启一次后退出，不能直接证明重开补齐。合成`sync-backfill-page-scenarios.ts`验证暂停／失败／显式重试，后端`CliBackgroundSyncTest.test_reopened_sync_backfills_messages_from_disabled_window`验证关闭窗口的正向消息恢复，均不能代签当前包真实CLI开关路径。

新增单case：`desktop/tests/real-sync-reenable-acceptance.spec.ts`，复用`real-sync-quit-fixture.ts`原随机隔离PG、私有单联系人范围、只读sandbox、CLI／WCDB路径、原游标白名单、双审计与认证退出。无需调度白名单改动：现runner按显式`tests/<name>.spec.ts`文件及Playwright `testMatch`动态登记。只改本测试和本文，不改产品、原fixture、冻结依赖或记忆提取。

## 既定验证接缝与操作

接缝沿已有公开管理页总开关、认证`/api/sync/status`与`/api/sync/follow-smoke/status`无正文摘要、自有CLI固定枚举审计。正式App及CLI接缝保留原真实实现；不从SQL补造状态，不改时钟、cursor或调用立即检查／手动重试。

1. 本轮新基线不早于实际许可起点，只允许既有已确认的一位联系人、约定测试文字及有限时段；没有来信授权。模型／OCR／旧前台凭据关闭，追踪／截图／视频关闭。
2. 公开页面开启同步，等待本阶段新tail子进程启动、同PID成功退出并被范围guard接受；核对一个active绑定、补齐完成、空窗口消息／来源／重复计数实际为0。
3. 同页面关闭总开关，UI确认关闭时立即记录自有CLI启动基线、在途tail数和在途流数，等待这些原进程正常退场；`finished`不计新启动。原fixture心跳固定60秒，所以从关闭确认起连续等65秒，核对包括退场等待期间在内的自有CLI启动增量0、流未重开、消息／来源／水位不变。
4. 在同一App／后端点重新开启，等待新的真实tail完成且被接受、重新建立的全局流活跃、补齐完成／1个会话／0失败／0无法确认；空窗口计数与水位保持。再等正式后台自然周期的新tail，不点立即检查或重试，复核计数与重复身份。
5. 正常菜单退出、原认证token停读、所有记录的自有CLI及后端PID退场，再等5秒核对CLI启动增量0；由原fixture精确回收本轮库和目录。

断言失败只记录固定阶段及已取得的布尔／计数，不输出身份、正文、原始错误、路径或凭据。空窗口仅认证关闭边界、有限范围内真实补读尝试、补齐状态和实际零消息／零重复计数；不认证有新消息的正向补齐、无丢失、来信、跨联系人连续性、App重启或录屏权限。

## 实际运行参数模板（准备，未执行）

由主Agent在桌面空闲后将下列变量赋为本轮私有绝对路径及带时区ISO8601时间，不能复用过期scope或打印其正文。`NOTALONE_TEST_APP_EXECUTABLE`指向当前已冻结v7签名包；scope取本轮新基线、单联系人、`allow_incoming_test_text=false`，建议8分钟，与runner截止一致。保留原`approved_texts`白名单，不为零消息场放宽guard。

```sh
conda activate NotAlone
cd desktop
NOTALONE_REAL_SYNC_REENABLE_ACCEPTANCE=1 \
NOTALONE_TEST_REAL_SYNC_SCOPE="$REENABLE_SCOPE_FILE" \
NOTALONE_TEST_APP_EXECUTABLE="$REENABLE_APP_EXECUTABLE" \
npm run test:app -- --interactive --coordinator main-agent \
  --from "$REENABLE_FROM_ISO" --until "$REENABLE_UNTIL_ISO" \
  --max-launches 1 -- tests/real-sync-reenable-acceptance.spec.ts \
  --output artifacts/real-sync-reenable-20261016
```

本case超时最多7分钟；scope限8分钟内、基线距开始不超过2分钟，准备完成时不足4分钟则拒绝开始，轮询最晚在截止前30秒停止以保留自有资源收尾。runner全程最多一次App启动，后端固定同一PID。不要设置旧`NOTALONE_REAL_FOREGROUND_*`／`NOTALONE_TEST_FOREGROUND_CREDENTIAL`或`NOTALONE_REAL_SYNC_VISUAL_ACCEPTANCE`，也不要设置旧退出case开关冒充重开case。

## 准备检查

已运行`cd desktop && npm run typecheck`，退出0；`NOTALONE_APP_TEST_FILES='["tests/real-sync-reenable-acceptance.spec.ts"]' node node_modules/playwright/cli.js test tests/real-sync-reenable-acceptance.spec.ts --list`安全发现单文件单case，退出0，未执行fixture。

两新文件以`9841bd1de4b1f339629b8dacfd6ffb188c4bf6f9`为基准独立审查：Spec最终0项，Standards硬违规0项／判断性建议0项。审查只读，未执行真实组件。两文件`git diff --no-index --check /dev/null <文件>`均无空白诊断；exit1表示新增文件的差异。

真实运行尚未执行，结果待主Agent实际完成后追加；不提前填写通过或关闭原04票。

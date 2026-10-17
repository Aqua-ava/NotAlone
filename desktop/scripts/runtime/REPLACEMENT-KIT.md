# 开源组件修改工具包

这是可选的开发工具，不影响普通用户双击 App。接收者无需 NotAlone 仓库、npm 模块、dist、共享缓存或 Conda。需要 macOS 15+ arm64、Node.js 22.12+ 和 Xcode Command Line Tools（clang、make、SDK、codesign）；修改工具本身的源码可直接阅读。离线开发 Python 与三个固定构建 wheel 在 `inputs/`，完整原始通知及索引在 `notices/`，来源和 SHA256 在 `scripts/runtime/*lock.json`，工具包字节清单为 `kit-inventory.json`。构建子进程仅使用本包独立 PBS 和系统工具。

先把整个 `replacement-kit` 目录复制到 App 以外的可写位置。不要在签名 App 内修改工具或源码。下列路径均需换成自己的绝对路径，`ORIGINAL` 是原 App。输出 App、修改运行时与构建目录必须不存在，且互不包含。保留原 App，停止使用修改副本后再替换自己的其它副本；工具不读取用户资料或任何默认 userData。

```sh
KIT=/absolute/replacement-kit
ORIGINAL=/absolute/NotAlone.app
node "$KIT/kit.mjs" check
# 将example.patch复制到工具包外，编辑为自己的源码修改。
cp "$KIT/example.patch" /absolute/recipient.patch
node "$KIT/kit.mjs" rebuild \
  --runtime-directory "$ORIGINAL/Contents/Resources/notalone-runtime" \
  --output-directory /absolute/modified-runtime \
  --work-directory /absolute/source-build \
  --patch-file /absolute/recipient.patch
node "$KIT/kit.mjs" install \
  --app-directory "$ORIGINAL" \
  --runtime-directory /absolute/modified-runtime \
  --output-app /absolute/Modified-NotAlone.app \
  --receipt /absolute/install-receipt.json
node "$KIT/kit.mjs" verify \
  --runtime-directory /absolute/Modified-NotAlone.app/Contents/Resources/notalone-runtime \
  --report-directory /absolute/verification
```

`rebuild` 是可编辑的窄样例：向完整 psycopg 3.3.6 的 Cython 源码加入可观察标记，真正编译两个扩展，链接从随包官方源码重建的 PG16.15 libpq。源码归档从原 App 的 `licenses/attribution/sources` 读取并核对摘要；补丁、完整修改源码、编译 wheel、安装后字节、基础来源及工具链记录保留在新运行时 `licenses/psycopg-replacement/`。`--patch-file`读取工具包外的接收者补丁，只允许源码根内的相对文件路径，通过`patch --batch --forward --fuzz=0`真正应用，失败即停止；不会改写已分发的工具脚本或要求篡改工具包清单。省略该参数时执行内置标记样例。补丁是接收者的修改，不是官方来源。该样例不是默认 PG18.6 客户端的逐字节复现，也未认证 TLS、LDAP、Kerberos 或 PG18 新特性。

`install` 只创建原 App 的新副本：核验原签名、两个运行时库存、固定 Python／后端兼容声明、全部 Mach-O 架构与包内依赖，保留 ASAR 和其它资源，替换新副本的运行时，再以本机 ad-hoc 签名及 deep/strict 校验。记录原 App 前后与复制资源的摘要、签名结果及运行时清单；失败不宣告成功，不覆盖或删除已存在路径。无需 Developer ID、私钥或 package.mjs。此工具不能代替你对修改行为的检查。

`verify` 使用独立合成 SCRAM 集群、随机 loopback 端口，执行当前随包迁移并真实 dump/restore，核对恢复值后停止自己的 PG，移除临时凭据、库和备份，仅留结果。不会连接已有数据库或模型服务。验证会额外复制一次运行时，需要足够磁盘；构建目录可在保存日志和来源后自行移除。

本工具包与原 App 保留的完整来源／通知共同交付。它提供已验证的本机修改与替换路径，不将 ad-hoc 签名声称为正式分发签名、公证或全部法律义务认证；干净 Mac、修改后的完整产品路径及其它兼容修改仍需分别验证。

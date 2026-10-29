# 语音转换第三方告知

语音转换使用silk-wasm 3.7.1，npm制品gitHead为`5971995be3ce05d4a1bf820fdf9d7ccdc942e945`，固定tarball的SHA512完整性值为`mXPwLRtZxrYV3TZx41jMAeKc80wvmyrcXIcs8HctFxK15Ahz2OJQENYhNgEPeCEOdI6Mbx1NxQsqxzwc3DKerw==`。制品中的JS和相邻silk.wasm由本地依赖解析，不从CDN下载。包内另捆绑wav-file-decoder 1.0.3的代码；产品不使用其WAV封装来代替独立检查。

本目录保留以下上游原始告知，随backend-ts/src整体进入受管运行时：

- `silk-wasm-LICENSE.txt`：[顶层MIT](https://github.com/idranme/silk-wasm/blob/5971995be3ce05d4a1bf820fdf9d7ccdc942e945/LICENSE)。
- `silk-wrapper-LICENSE.txt`：[SILK封装条款](https://github.com/idranme/silk-wasm/blob/5971995be3ce05d4a1bf820fdf9d7ccdc942e945/binding/libSilkCodec/silk/LICENSE)。
- `skype-sdk-NOTICE.txt`：[SDK源码版权头](https://github.com/idranme/silk-wasm/blob/5971995be3ce05d4a1bf820fdf9d7ccdc942e945/binding/libSilkCodec/silk/src/SILK_SDK_SRC_ARM_v1.0.9/src/SKP_Silk_dec_API.c)。该条款明确不授予专利许可，顶层MIT不覆盖这一限制。
- `wav-file-decoder-LICENSE.txt`：从[固定npm制品](https://registry.npmjs.org/wav-file-decoder/-/wav-file-decoder-1.0.3.tgz)取得的原始许可。

接口以固定版本的[TypeScript实现](https://github.com/idranme/silk-wasm/blob/5971995be3ce05d4a1bf820fdf9d7ccdc942e945/src/index.ts)、`decoder.c`和`src/include/common.h`核对。输入限制取共同头中的MAX_BYTES_PER_FRAME=250、MAX_INPUT_FRAMES=5、MAX_LBRR_DELAY=2；不使用宽松isSilk/getDuration补造完整性或真实播放时长。未认证真实资源关联的渠道保持不可读取。

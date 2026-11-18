// 桌面无头浏览器测试共享的启动与挂载接缝；只服务测试，不进入产品代码。
// 本模块不在顶层导入 Playwright，仅在启动浏览器时才加载。

/**
 * 启动无头 Chromium。设置 NOTALONE_TEST_CHROMIUM_PATH 时使用该可执行文件，
 * 否则回退到本机已安装的 Chrome（channel: 'chrome'）；options 可覆盖默认值，如 timeout。
 */
export async function launchChromium(options = {}) {
  const { chromium } = await import('@playwright/test');
  const executablePath = process.env.NOTALONE_TEST_CHROMIUM_PATH;
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: 'chrome' }), ...options });
}

/** 向空白页挂载 esbuild iife 产物：根节点 #root 加首个输出文件（脚本）。 */
export async function mountBundle(page, bundle) {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}

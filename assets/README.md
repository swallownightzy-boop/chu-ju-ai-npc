# assets/

## 字体（可选，但强烈建议）

这套 UI 的像素风味全靠 `ZCOOL QingKe HuangYou` 这款字体。现在它通过 `@import`
从 Google Fonts 加载 —— **在中国大陆网络下大概率失败**，失败后会回退到微软雅黑，
整个像素感就没了。

### 让它彻底离线可用

1. 下载字体（OFL 开源许可，可自由使用与分发）：

   - Google Fonts 页面：https://fonts.google.com/specimen/ZCOOL+QingKe+HuangYou
   - 或直接从 CDN 取 woff2：
     `https://fonts.gstatic.com/s/zcoolqingkehuangyou/…/ZCOOLQingKeHuangYou-Regular.woff2`

2. 把文件重命名为 `ZCOOLQingKeHuangYou-Regular.woff2`，放到本目录下：

   ```
   ai npc/assets/ZCOOLQingKeHuangYou-Regular.woff2
   ```

3. 刷新页面即可，无需改任何代码 —— `index.html` 里的 `@font-face` 会自动命中它。

代理服务已经允许 `.woff2` 的 MIME 类型，放进来自动就能加载。

### 如果拿不到字体文件

不影响可玩性，只是观感打折。回退栈已经补了几款常见的本地像素字体
（`Zpix`、`Fusion Pixel 12px`），装了其中之一也能出效果。

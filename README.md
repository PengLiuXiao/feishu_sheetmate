# Feishu SheetMate Preview

一个无需构建步骤的 Chrome Manifest V3 插件，用来在飞书表格页面里预览当前单元格内容。

当前支持的飞书工作区域名：

- `*.feishu.cn`
- `*.larksuite.com`
- `*.larkoffice.com`

## 当前能力

- 侧边栏单栏、左右分屏、上下分屏
- 按 Chrome 标签页隔离状态
- 当前激活分栏会跟随飞书里新选中的单元格
- 未激活分栏保持原内容不变，适合做对照阅读
- 自动识别并预览：
  - 纯文本
  - Markdown
  - JSON
  - LaTeX（本地 KaTeX 渲染）
  - 图片、视频直链
  - 视频平台页面链接识别与原因提示
- 支持显式切换渲染模式：
  - 自动识别
  - 纯文本
  - Markdown
  - JSON
  - LaTeX
  - 媒体链接

## 目录说明

- `manifest.json`：插件声明
- `src/background.js`：侧边栏行为与按标签页存储的最新单元格快照
- `src/content-script.js`：从飞书表格页面提取当前选中的单元格内容
- `src/sidepanel/sidepanel.html` / `src/sidepanel/sidepanel.css` / `src/sidepanel/sidepanel.js`：侧边栏界面和渲染逻辑
- `src/shared/`：预留给后续共享常量、存储 key 和通用工具
- `tests/background/` / `tests/content/` / `tests/sidepanel/`：按模块镜像组织的测试
- `vendor/katex/`：本地 KaTeX 静态资源，用于离线公式渲染

## 本地安装

1. 打开 Chrome 的 `chrome://extensions/`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择当前目录：`/Users/vincentliu/Coding/Byte_Work/feishu_sheetmate`
5. 打开飞书表格页面
6. 点击插件图标即可打开侧边栏

支持以上三类域名下的飞书表格页面，例如：

- `https://xxx.feishu.cn/sheets/...`
- `https://xxx.larksuite.com/sheets/...`
- `https://xxx.larkoffice.com/sheets/...`

## 交互规则

- 每个飞书表格标签页都有自己独立的布局、激活分栏和冻结内容
- 点击分栏 A 或 B，即可把该分栏设为“跟随中”
- 跟随中的分栏会随着你在飞书里切换单元格而更新
- 未被选中的分栏保持冻结，适合做前后内容对照
- 单栏模式下固定只显示分栏 A

## 提取策略说明

由于飞书表格是动态页面，`src/content-script.js` 当前采用的是“多策略提取”：

- 优先读公式栏/输入框/编辑态文本
- 其次读当前高亮或选中的单元格文本
- 尝试从名称框、坐标属性里识别类似 `B12` 的单元格位置

如果你在真实飞书页面里发现没有正确抓到内容，优先调这几个常量：

- `FORMULA_BAR_SELECTORS`
- `NAME_BOX_SELECTORS`
- `SELECTED_CELL_SELECTORS`

它们都位于 [content-script.js](file:///Users/vincentliu/Coding/Byte_Work/feishu_sheetmate/src/content-script.js)。

## 已知限制

- 图片/视频优先支持以下链接：
  - 文件后缀可直接判断的直链
  - Markdown 图片语法中的链接
  - 常见飞书 / Lark 媒体链接
  - 带 `filename` / `name` 等参数且能推断扩展名的链接
- 当前会识别并说明原因的平台视频页：
  - YouTube 标准视频链接：`watch` / `youtu.be` / `shorts` / `embed`
  - Bilibili 标准视频链接：`/video/BV...` / `/video/av...`
- 当前不处理：
  - YouTube playlist / channel / live 专门解析
  - Bilibili `b23.tv` 短链、番剧、课程等非标准视频页
- 视频平台页面链接默认不在侧边栏内播放，会显示原因说明和原页面入口
- 无法安全嵌入的其他链接会保留为可点击外链，不会做代理转发，也不会透传任意 iframe 地址
- 飞书页面 DOM 如果发生较大调整，可能需要补充选择器
- 浏览器重启后不会恢复上一次会话中的冻结内容，这些状态仅保存在当前浏览器会话内

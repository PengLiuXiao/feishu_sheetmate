# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 **Chrome Manifest V3 扩展**，用于在飞书（Feishu/Lark）表格页面预览单元格内容。核心特性：
- 无构建步骤，纯原生 JavaScript
- 侧边栏支持单栏、左右分屏、上下分屏三种布局
- 按标签页隔离状态，每个飞书表格标签页独立管理布局和分栏内容
- 自动识别内容类型：纯文本、Markdown、JSON、LaTeX、图片/视频链接
- 支持手动切换渲染模式

支持域名：`*.feishu.cn`、`*.larksuite.com`、`*.larkoffice.com`

## 架构与文件职责

这是一个三层架构的 Chrome 扩展：

### 1. Background Service Worker (`src/background.js`)
- 管理侧边栏生命周期和行为
- 存储每个标签页的单元格快照（`chrome.storage.session`）
- 动态注入 content script 到飞书页面
- 处理跨标签页的状态隔离逻辑
- **关键数据结构**：
  - `sheetMateSnapshot:{tabId}` - 单元格内容快照
  - `sheetMatePanelState:{tabId}` - 侧边栏布局和分栏状态
  - `sheetMateCaptureStatus:{tabId}` - content script 连接状态

### 2. Content Script (`src/content-script.js`)
- 在飞书表格页面运行，提取当前选中单元格的内容
- 多策略提取逻辑：优先级从高到低
  1. 公式栏/输入框/编辑态文本
  2. 当前高亮或选中的单元格文本
  3. 从名称框识别单元格位置（如 `B12`）
- 监听 DOM 变化和用户交互，自动捕获内容更新
- 监控扩展上下文有效性，失效时自动清理
- **关键选择器常量**（位于 `src/content-script.js` 顶部区域）：
  - `FORMULA_BAR_SELECTORS` - 公式栏定位
  - `NAME_BOX_SELECTORS` - 名称框定位
  - `ACTIVE_CELL_SELECTORS` - 选中单元格定位

### 3. Side Panel (`src/sidepanel/sidepanel.html` / `src/sidepanel/sidepanel.js` / `src/sidepanel/sidepanel.css`)
- 侧边栏 UI 和渲染逻辑
- 三种布局模式：`single`（单栏）、`columns`（左右分屏）、`rows`（上下分屏）
- 两个独立分栏（paneA / paneB），点击切换激活状态
- 激活分栏跟随飞书单元格更新，未激活分栏冻结内容
- 五种渲染模式：`auto`（自动识别）、`text`、`markdown`、`json`、`latex`、`media`
- 使用本地 KaTeX (`vendor/katex/`) 离线渲染 LaTeX

## 目录约定

当前仓库采用“根目录保留清单文件 + 业务代码进 `src/` + `sidepanel` 独立目录 + 测试按模块镜像”的结构：

```text
.
├── manifest.json
├── package.json
├── package-lock.json
├── README.md
├── CLAUDE.md
├── AGENTS.md
├── vitest.config.js
├── .github/
├── src/
│   ├── background.js
│   ├── content-script.js
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.js
│   │   └── sidepanel.css
│   └── shared/
├── tests/
│   ├── helpers/
│   ├── background/
│   ├── content/
│   └── sidepanel/
└── vendor/
    └── katex/
```

后续修改时请优先按以下位置查找和落文件：

- 根目录：只保留扩展清单、工程配置、说明文档
- `src/background.js`：后台 Service Worker 逻辑
- `src/content-script.js`：飞书页面采集逻辑与选择器
- `src/sidepanel/`：侧边栏 HTML、CSS、JS
- `src/shared/`：预留共享常量、存储 key、通用工具
- `tests/background/`、`tests/content/`、`tests/sidepanel/`：按模块镜像组织的测试
- `vendor/`：第三方静态资源，保持无构建步骤

## 开发命令

### 测试
```bash
npm test              # 交互式测试模式（watch mode）
npm run test:run      # 单次运行所有测试
npm run test:coverage # 生成覆盖率报告
```

测试框架：Vitest + jsdom，配置文件 `vitest.config.js`。
测试文件位于 `tests/` 目录，对应三个核心文件：
- `tests/background/background.test.js`
- `tests/content/content-script.test.js`
- `tests/sidepanel/sidepanel.test.js`

### 本地安装与调试
1. 打开 `chrome://extensions/`，启用"开发者模式"
2. 点击"加载已解压的扩展程序"，选择当前目录
3. 打开飞书表格页面（如 `https://xxx.feishu.cn/sheets/...`）
4. 点击扩展图标打开侧边栏
5. 修改代码后，在 `chrome://extensions/` 点击刷新按钮重新加载

**调试技巧**：
- Background 日志：在 `chrome://extensions/` 点击"Service Worker"查看
- Content script 日志：在飞书页面打开开发者工具（F12）
- Side panel 日志：侧边栏右键 → 检查 → 单独的开发者工具窗口

## 核心交互逻辑

### 状态隔离
- 每个飞书表格标签页有独立的：布局模式、激活分栏、分栏内容、渲染模式
- 切换标签页时，侧边栏自动加载该标签页的状态
- 关闭标签页时，自动清理对应的存储数据

### 分栏激活与冻结
- 点击分栏 A 或 B，该分栏变为"跟随中"（activated）
- 跟随中的分栏随飞书单元格切换而更新内容
- 未激活分栏保持冻结，适合做内容对照
- 单栏模式固定显示 paneA

### 内容提取触发时机
- 用户点击单元格
- 键盘导航（方向键）
- 公式栏获得焦点
- DOM 变化（MutationObserver）
- 定时轮询（1200ms，作为兜底）

## 修改与扩展指南

### 新增内容类型识别
1. 在 `src/sidepanel/sidepanel.js` 中添加检测逻辑（参考现有的 `detectMarkdown`、`detectJSON` 等函数）
2. 在 `SUPPORTED_MODES` 常量中添加新模式
3. 在 `renderContent` 函数中添加渲染分支
4. 在 `src/sidepanel/sidepanel.html` 的 `<select class="mode-select">` 中添加选项
5. 添加对应测试到 `tests/sidepanel/sidepanel.test.js`

### 调整飞书页面提取策略
如果飞书 DOM 结构变化导致无法提取内容：
1. 打开飞书表格页面，F12 审查选中单元格的 DOM 结构
2. 在 `src/content-script.js` 中更新对应的选择器常量：
   - `FORMULA_BAR_SELECTORS` - 公式栏识别
   - `NAME_BOX_SELECTORS` - 名称框识别
   - `ACTIVE_CELL_SELECTORS` - 选中单元格识别
3. 运行 `npm run test:run` 确保测试通过
4. 在真实飞书页面验证

### 修改布局样式
- `src/sidepanel/sidepanel.css` 控制所有样式
- 布局切换通过 `.layout--single`、`.layout--columns`、`.layout--rows` 类实现
- 分栏激活通过 `.pane--active` 类高亮显示（添加了可见的环形边框）
- 响应式断点已设置，小屏自动切换为单栏

## 已知限制与权衡

- **无构建步骤**：为了降低维护成本，放弃了 TypeScript、打包工具、CSS 预处理器
- **内容提取依赖 DOM 选择器**：飞书页面结构变化可能需要更新选择器
- **会话存储**：浏览器重启后不保留冻结内容，仅保存在当前会话中
- **视频平台限制**：YouTube/Bilibili 等平台视频页面不在侧边栏内嵌播放（跨域限制），仅显示说明和原页面链接
- **图片/视频支持范围**：优先支持直链和飞书/Lark 媒体链接，带 `filename`/`name` 参数的链接需能推断扩展名

## 代码风格约定

- 使用原生 JavaScript（ES6+），不引入框架
- 函数优先使用 `function` 声明（而非箭头函数），提升可读性和栈追踪友好性
- 常量使用 `UPPER_SNAKE_CASE`，函数和变量使用 `camelCase`
- 选择器常量集中定义在文件顶部，便于维护
- 错误处理静默忽略非关键错误（如冷启动时的 Chrome API 短暂报错），关键错误记录到 console
- 测试使用 `globalThis.__SHEET_MATE_TEST__` 标记，避免自动初始化干扰测试环境

## 测试策略

- 每个核心文件对应一个测试文件，保持文件级覆盖
- 使用 jsdom 模拟浏览器环境和 Chrome Extension API
- 关键逻辑单元测试覆盖：
  - 提取逻辑（多选择器策略）
  - 内容类型识别（Markdown、JSON、LaTeX）
  - 布局切换与分栏激活
  - 状态持久化与恢复
- Mock Chrome API 调用，避免依赖真实浏览器环境

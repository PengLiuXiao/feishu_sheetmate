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
- 补充动态注入：扩展安装/更新后对已打开的飞书标签页注入 content script
- 处理跨标签页的状态隔离逻辑
- **关键数据结构**：
  - `sheetMateSnapshot:{tabId}` - 单元格内容快照
  - `sheetMatePanelState:{tabId}` - 侧边栏布局和分栏状态
  - `sheetMateCaptureStatus:{tabId}` - content script 连接状态

### 2. Content Script (`src/content-script.js`)
- 通过 manifest.json 静态声明，在飞书页面加载时自动注入
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
├── manifest.json              # Chrome 扩展清单
├── package.json               # npm 脚本与开发依赖
├── package-lock.json
├── README.md                  # 用户说明文档
├── CLAUDE.md                  # 仓库协作与目录约定
├── AGENTS.md                  # 与 CLAUDE.md 保持同步的代理说明
├── vitest.config.js           # Vitest 配置（environment: jsdom, globals: true）
├── .github/                   # CI 配置
├── .gitignore                 # Git 忽略规则（包含 node_modules/, coverage/, release/）
├── src/                       # 业务代码
│   ├── background.js          # 后台 Service Worker 逻辑
│   ├── content-script.js      # 飞书页面采集逻辑与选择器
│   ├── sidepanel/             # 侧边栏 HTML、CSS、JS
│   │   ├── sidepanel.html
│   │   ├── sidepanel.js
│   │   └── sidepanel.css
│   └── shared/                # 预留共享常量、存储 key、通用工具（当前为空）
├── scripts/                   # 自动化脚本（打包、部署等）
│   └── package-extension.sh   # 打包脚本
├── release/                   # 发布产物目录（git ignored）
│   ├── feishu-sheetmate-v{version}/
│   └── feishu-sheetmate-v{version}.zip
├── tests/                     # 按模块镜像组织的测试
│   ├── helpers/               # 测试辅助工具
│   │   └── script-loader.js   # 测试环境中加载源文件的工具
│   ├── background/
│   │   └── background.test.js
│   ├── content/
│   │   └── content-script.test.js
│   └── sidepanel/
│       └── sidepanel.test.js
├── coverage/                  # 测试覆盖率报告（git ignored，npm test 自动生成）
└── vendor/                    # 第三方静态资源
    └── katex/                 # KaTeX 离线渲染库（katex.min.js + katex.min.css）
```

## 开发命令

### 测试
```bash
npm test              # 交互式测试模式（watch mode），自动生成覆盖率报告到 coverage/
npm run test:run      # 单次运行所有测试
```

测试框架：Vitest + jsdom（配置：`vitest.config.js`）
- 环境：jsdom 模拟浏览器 DOM
- 全局 API：`describe`、`it`、`expect` 等自动注入
- Mock 重置：每次测试后自动恢复 mock 状态（`restoreMocks: true`）

测试文件位于 `tests/` 目录，对应三个核心文件：
- `tests/background/background.test.js` - Service Worker 逻辑与状态管理
- `tests/content/content-script.test.js` - 飞书页面内容提取逻辑
- `tests/sidepanel/sidepanel.test.js` - 侧边栏渲染与交互逻辑

### 打包发布

**本地打包**：
```bash
npm run package       # 或直接运行 ./scripts/package-extension.sh
```

该脚本会：
1. 从 `manifest.json` 读取版本号（当前 0.1.0）
2. 在 `release/` 目录创建 `feishu-sheetmate-v{version}/` 文件夹
3. 复制 `manifest.json`、`src/`、`vendor/` 到打包目录
4. 生成 `feishu-sheetmate-v{version}.zip` 压缩包

发布产物仅包含运行时必需文件，不包含 `tests/`、`scripts/`、`node_modules/`、`.github/` 等开发文件。

**自动发布到 GitHub Releases**：
1. 更新 `manifest.json` 中的版本号（如 `0.2.0`）
2. 提交更改并推送到 main 分支
3. 创建并推送对应的 Git tag：
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. GitHub Actions 自动触发 `.github/workflows/release.yml`：
   - 验证 tag 版本与 manifest.json 版本一致
   - 执行打包脚本生成 zip
   - 创建 GitHub Release 并上传 zip 附件

注意：tag 格式必须为 `v{version}`（如 `v0.2.0`），且必须与 `manifest.json` 中的版本号匹配，否则构建失败。

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
- **平台视频页面**：YouTube/Bilibili 标准视频链接会转为 iframe 预览，同时保留原页面链接；若平台拒绝嵌入，用户仍可打开原链接
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

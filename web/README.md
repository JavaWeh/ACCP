# ACCP Web 控制台

技术栈：TypeScript、React 19、Vite、HeroUI v3 和 Tailwind CSS v4。
依赖版本固定在 `package.json` 与 `package-lock.json`。

## 开发

```sh
npm ci --ignore-scripts
npm run dev
```

Vite 将 `/api` 代理至 `http://127.0.0.1:18080`。登录与业务数据来自 ACCP API。

## UI 约定

- `src/ui.tsx` 组合 HeroUI 的表单、输入、选择、复选框、弹窗和状态反馈。
  业务表单保留 `FormData`，单选默认首项，多选以同名字段提交每个值。
- `Field` 提供字段名与说明，控件内部的 HeroUI `Label`、`Description` 和
  `FieldError` 负责标签关联和校验反馈。必填、禁用和只读状态传递给字段容器。
- HeroUI v3 无需 `HeroUIProvider`；入口使用 `I18nProvider` 设置中文交互文案。
- `src/style.css` 按 Tailwind、HeroUI、项目主题的顺序导入样式。
  `src/tokens.css` 配置蓝紫色品牌主题、表单边框和圆角。页面布局与响应式网格
  使用 TSX 中的 Tailwind v4 工具类；`style.css` 只维护基础排版与复用内容样式，
  并使用 `@layer` / `@apply` 管理，保留 HeroUI 的交互状态。
- 弹窗使用 HeroUI 的焦点管理、Escape 关闭和背景隔离；任务详情使用可通过方向键
  切换的 Tabs；表格、卡片、头像和状态标签使用 HeroUI 组件。

## 验证

```sh
npm run check:format
npm run build
npx playwright install chromium
npm run test:ui
```

`test:ui` 自动启动独立 Vite 服务，使用合成 API 响应验证组件交互、键盘焦点、
表单载荷和移动端布局，不需要真实凭证或后端。
本机已有 Chrome 时可设置 `ACCP_UI_BROWSER=chrome`；CI 默认使用 Chromium。
自动无障碍检查覆盖登录、工作区、创建任务弹窗和成员表格的 WCAG A/AA 规则，
不代表已完成所有辅助技术的人工验收。

`npm test` 是真实 API 与数据库的端到端验收，需要独立开发部署及
`ACCP_WEB_URL`、`ACCP_WEB_CREDENTIALS_FILE`，详见
[开发工作流](../docs/development-workflow.md#web-验证)。模拟 API 测试不能代替这组验收。

参考：[HeroUI 官方接入指南](https://heroui.com/en/docs/react/getting-started/quick-start)。

## 品牌资源

项目提供的 Logo 原始文件存放在 `public/brand/`，SVG 与 PNG 均保持原样。

| 文件 | 用途 |
| --- | --- |
| `accp-logo-mark.svg` | 登录页图标、浏览器 favicon |
| `accp-logo-horizontal.svg` | 浅色侧栏横版 Logo |
| `accp-logo-dark-card.svg` | 深色品牌展示卡 |
| `accp-logo-mark.png` | 标志的 PNG 版本 |
| `accp-logo-dark-card.png` | 深色展示卡的 PNG 版本 |

界面以 Logo 的蓝紫色为主色，中性灰白作为背景。Logo 自身的渐变保持原样。

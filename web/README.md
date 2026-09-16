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
- HeroUI v3 无需 `HeroUIProvider`；入口的 `LocaleProvider` 同步应用文案与
  HeroUI `I18nProvider` 的语言。
- `src/style.css` 按 Tailwind、HeroUI、项目主题的顺序导入样式。
  `src/tokens.css` 配置蓝紫色品牌主题、表单边框和圆角。页面布局与响应式网格
  使用 TSX 中的 Tailwind v4 工具类；`style.css` 只维护基础排版与复用内容样式，
  并使用 `@layer` / `@apply` 管理，保留 HeroUI 的交互状态。
- 弹窗使用 HeroUI 的焦点管理、Escape 关闭和背景隔离；任务详情使用可通过方向键
  切换的 Tabs；表格、卡片、头像和状态标签使用 HeroUI 组件。

## 国际化

- 支持简体中文（`zh-CN`）、English（`en-US`）和 Русский（`ru-RU`）。
  登录页和工作区顶栏均可切换，
  即时更新界面、无障碍标签、页面标题及 HTML `lang`，保留当前页面和输入内容。
- 首次访问选择浏览器语言列表中的首个中文、英文或俄语；均不支持时回退简体中文。
  手动选择存储在 `localStorage` 的 `accp.locale`，优先于浏览器偏好。
  浏览器禁用存储时仍可在当前页面切换。
- `src/locales/zh-CN.ts` 定义源语言消息 ID 和文案；`en-US.ts`、`ru-RU.ts` 使用相同 ID，
  TypeScript 检查键完整性。组件通过 `useI18n().translate` 获取文案。
  新增文案时同时更新所有语言文件，避免拼接句子；变量使用 `{name}` 占位符。
  计数文案传入数值 `count`，通过 `Intl.PluralRules` 选择数量形式；英文使用
  `one/other`，俄语使用 `one/few/many/other`，缺少某种形式时回退到 `other`。
- `label` 翻译协议枚举的展示名称；未知枚举保留原值。
  `number`、`stamp` 和 `time` 使用当前语言的 `Intl` 格式化，日期保持浏览器时区。
  用户内容、API 字段和枚举值、服务端原始错误详情不作为界面文案翻译。
  前端错误使用 `LocalizedError`，已有错误也会随语言切换。

## 验证

```sh
npm run check:format
npm run build
npx playwright install chromium
npm run test:ui
```

`test:ui` 自动启动独立 Vite 服务，使用合成 API 响应验证组件交互、键盘焦点、
表单载荷、三语切换、语言偏好、日期与复数、翻译完整性和移动端布局，
不需要真实凭证或后端。原有用例明确使用中文，国际化用例另行覆盖英文和俄语。
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

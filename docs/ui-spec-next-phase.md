# ACCP 下一阶段 UI 设计规范（US-11b/12/13b/14/14b/15，附 US-5）

- 作者：jack（UI 设计）｜日期：2026-10-20｜修订：2026-10-27｜状态：草案 **v3.4**（chatgpt UI 审核 must-fix 已落地；C1–C6 已关闭）；**M5（§6 / US-14 / US-14b / US-15）已落地 2026-10-27**（`19e3428` / `d69cc2d` / `f5e63a8`）；实现验收 chatgpt **pass_with_suggestions**、**无 MUST_FIX**（非阻塞建议未编码）
- 依据：`docs/product-plan-next-phase.md` 草案 **v5.1**、`docs/requirements-next-step.md` **v3.1**；US-5/11b/12/13b/14/14b/15；现有前端 `web/src`（React 19.3、Vite 8、HeroUI 3.2.5、Tailwind 4.3）
- Figma 低保真线框：<https://www.figma.com/design/k3OpUtH1QpUfO8gQrq5qQY> （新建文件，5 个画框，对应本文第 3–7 节；灰阶，仅表达布局与编号注释。画框使用 Inter 字体，中文若显示为缺字，以本文为准；v3.3 起含「组织账号」画框）
- 原则：**沿用现有组件，不引入新依赖**；本规范只描述设计，不改代码。
- 修订记录：2026-10-20 v2，依据 `docs/audit-next-phase.md`（claude 审计）更新：分页仅「本页 N 条」、排序分阶段交付、深链登录回跳只补查询参数和 hash、404/403 文案拆分、`Idempotency-Replayed` 响应头、停用改为项目级。
- 修订记录：2026-10-20 v3，依据 peter 更新后的产品方案：隐藏「项目」筛选（O2）；新增「链接失效」页及「返回项目概览」（O4）；归档改为普通二次确认并新增「恢复」入口（O9）；停用不自动转交、提示走任务交接 D07、可选显示未完成任务数（O10）；统一停用确认文案；新增 409 `LAST_ADMIN` 错误处理。
- 修订记录：2026-10-20 v3.1，claude 复审通过后小改：删除第一阶段排序说明（id 为随机 16 字节十六进制串，与创建时间无关，第一阶段不对排序做承诺，O3a）；停用只吊销本项目委托的 Agent/MCP 会话，不影响本人 OIDC 登录及其他项目，相关文案更正（O12）。
- 修订记录：2026-10-20 v3.2，以 PRD v3（US-11a/11b、UI 需求第 1 项）为准重写 §3：排序不再分阶段，仅「更新时间 / 标题」×升/降序，始终有选中项（默认更新时间降序），前端显式传 sort/order 并写入 URL，表头可点击 + aria-sort；分页改为「加载更多」/「已全部加载」，加载与出错态、焦点与「已加载 N 条」播报；筛选/排序变化重置与 INVALID_CURSOR 兜底；更新 axe 清单与开放问题（O3、O3a 结论更新，新增引用 PRD Q10）。早期修订记录中的旧表述（如分阶段排序、按页计数）均已被本版取代。
- 修订记录：2026-10-25 **v3.3**，对齐 PRD 草案 v5 / requirements v3（Weh 拍板 Q1–Q10、Q9a）：① 重写 §6 权限呈现（组织 ADMIN ≠ 项目 ADMIN，与 registerHuman 不对称）；② 补齐 **US-14b** 组织账号页、账号级停用确认（可写「无法登录」）、与项目级入口严格分区；③ US-14 确认文案与 PRD 逐字对齐；④ 补 US-15 归档阻塞列表；⑤ 核对 US-11b「已全部加载」、US-12、US-13b 与 PRD v5 一致；⑥ O13/O8/O3a(Q10) 标已解决；文末列需 chatgpt 审核的开放点 C1–C6。
- 修订记录：2026-10-25 **v3.4**，按 `docs/ui-audit-next-phase.md`（chatgpt，有条件通过）must-fix + Weh 确认 C2：① 统一 §6.1/§6.0「有限只读」；② `/me.is_org_admin`（C1）；③ 成员列表拆 `membership_active`/`account_active` + Chip（C4）；④ 账号级停用鉴权仅组织 ADMIN、禁止复用「任一项目 ADMIN」（C6/M4）；⑤ 组织 ADMIN 可建项目并注明扩展 createProject 鉴权（C3）；⑥ M5 MVP 路由 `management?tab=org-accounts`，独立 URL 标后续（C5）；⑦ 补 409 `LAST_ORG_ADMIN` UI；⑧ §0/axe/§13 同步，C1–C6 全部标已解决。
- 修订记录：2026-10-27 **状态同步（正文未改）**：§6 / M5 实现已落地；验收 **pass_with_suggestions**、无 MUST_FIX；组织 ADMIN 授予/撤销与账号恢复仍延期；chatgpt 非阻塞建议未编码。

---

## 0. 现状梳理（读代码结论）

| 方面 | 现状 | 对本规范的影响 |
|---|---|---|
| 路由 | 仅 `/projects/:projectID/:page`（及 tasks/:id）；非法段落现网回退 overview | US-12 失效页；**组织账号 M5 MVP** 用 `.../management?tab=org-accounts`，不新增 pathname（C5） |
| 组件封装 | `ui.tsx` 封装 `Button`、`Badge(Chip)`、`Empty(Card)`、`Field/Input/TextArea/Select/Checkbox`、`Message(Alert danger, role=alert)`、`Form`（含 busy/Spinner/防重复提交）、`Modal`（HeroModal，blur，可点遮罩关闭）、`Action` | 新界面一律用这些封装；新增仅需「确认对话框」变体（不可点遮罩关闭） |
| 任务列表 | `tasks.tsx`：ToggleButtonGroup（全部/我负责的）、搜索（250ms 防抖）、状态 Select、游标分页（`limit=25`、`cursor`、`previous[]`），Table | US-11 在此基础上加负责人筛选、排序、分页器、三态 |
| 写操作 | `api.ts`：POST 带 `Idempotency-Key`（同一操作在结果未知时复用 key），`AbortSignal.timeout(20000)`，5xx/超时保留 key | US-13 只需把「超时」从普通错误里区分出来，并给重试 + 幂等反馈 |
| 权限 | 项目 `roles`：`ADMIN` / `REVIEWER` / `MEMBER`；管理页现网 `administrator = 任一项目含 ADMIN`。**v3.4 起**：组织 ADMIN 为独立标志 `me.is_org_admin`（与「任一项目 ADMIN」不对称，见 §6.0） | US-14/15/14b 按角色**隐藏**入口；矩阵见 §6.0/6.1；直链无权限/403 |
| 管理页 | `management.tsx`：两栏卡片表单；`<Json>` 展示；「操作原因」 | 改为四 Tab（含组织账号）+ Table；项目成员 API 须拆 `membership_active` / `account_active`（现网合成单一 `active`，见 C4） |
| i18n | `i18n.tsx`：`zh-CN / en-US / ru-RU`，key 为中文原文，`translate(key)`，存储键 `accp.locale`；`LocalizedError` | 所有新文案以中文作 key，三语同步加入 `locales/*.ts` |
| Token | `tokens.css`：accent `#445bff`、muted `#526175`、border `#e2e8f0`、radius 0.5rem 等 | 复用，见 §8 DTCG token |
| 测试 | `@axe-core/playwright` 4.13、Playwright | 附 axe 清单 §10 |

---

## 1. 通用约定

### 1.1 间距（8pt 栅格）

- 基础单位 8px，细调 4px。Tailwind 对应：`gap-2`(8) `gap-4`(16) `gap-6`(24) `p-6`(24) `mb-6`(24) `gap-8`(32)。
- 页面区块间 24px（`gap-6`），卡片内边距 24px（`p-6`），控件组间 16px（`gap-4`），图标与文字 8px（`gap-2`）。
- 禁止使用 `gap-3`/`p-5` 等非 8/4 倍数以外的值（`gap-1`=4 允许用于细调）。

### 1.2 文案与 ru-RU 长度余量

- 按钮、Tab、Chip：**不定宽**（禁止 `w-*` 固定宽度），使用 `min-w-*` + `px-4`；设计稿按中文宽度预留 **+40%**（en 约 +30%，ru 约 +40~60%）。
- 筛选栏、分页器、对话框按钮区使用 `flex flex-wrap gap-4`，ru 下允许换行；不得截断按钮文字。
- 表头允许两行（`whitespace-normal`），单元格长文本用 `break-words`；仅任务标题列可 `line-clamp-2` 并通过 `title`/详情查看全文。
- 提示语句（Alert、空态说明）最大宽度 `max-w-prose`（约 65ch），ru 文本比中文长约 2–2.5 倍字符，按行数而非字符预算。
- 数字/日期用 `Intl` 按 locale 格式化；复数用 `{count}` 占位并在 ru 中使用「Найдено: {count}」这类免变格写法（现有 ru 词典已采用此模式，如「Попыток: {count}」）。

### 1.3 无障碍通用要求（WCAG 2.2 AA）

- 文本对比度 ≥ 4.5:1，大字/图形/控件边界 ≥ 3:1。注意：`--border #e2e8f0` 对白底仅约 1.2:1，**不得作为输入框/控件唯一边界**——表单控件沿用 `--field-border #cbd5e1`（约 1.5:1，仍不足 3:1）→ **Must fix**：建议控件边框改用 `#64748b`（约 4.8:1）或以底色+边框组合满足 1.4.11（见开放问题 O1）。
- 交互目标 ≥ 24×24 CSS px（表格行内图标按钮用 `size-8`=32px）。
- 可见焦点：沿用 HeroUI `focus-visible` ring（`--focus #445bff`，对白底约 5.4:1），焦点不能被吸顶筛选栏遮挡（2.4.11：滚动容器加 `scroll-padding-top`）。
- 状态不只靠颜色：Chip 带文字，错误带图标 + 文本。
- 动态提示：结果计数、复制成功、超时/重试用 `role="status"`（`aria-live="polite"`）；阻断性错误沿用 `Message` 的 `role="alert"`。
- 320px 宽重排（1.4.10）：表格在 `<sm` 折叠为卡片列表。

---

## 2. 页面清单与优先级

| # | 界面 | 故事 | 交付期限 |
|---|---|---|---|
| 3 | 任务列表：筛选/排序/加载更多/三态 | US-11b（依赖后端 US-11a） | M4 开工前 |
| 4 | 深链接、复制链接、无权限页、链接失效页 | US-12 | M4 开工前 |
| 5 | 写操作超时、重试、已成功无需重复 | US-13b（依赖 US-13a 响应头） | M4 开工前 |
| 6 | 本项目成员管理 | US-14 | **M5 已落地**（`19e3428`） |
| 6b | 组织账号 / 账号级停用（仅组织 ADMIN） | US-14b | **M5 已落地**（`d69cc2d`；授予/撤销与账号恢复仍延期） |
| 6c | 项目归档恢复、仓库登记 | US-15 | **M5 已落地**（`f5e63a8`） |
| 7 | GitHub 同步失败文案（可选） | US-5 | 随 M1 |

---

## 3. 任务列表（US-11b，后端依赖 US-11a）

> v3.2 起以 PRD v3 为准：排序**不再分阶段**，只提供「更新时间」「标题」×升/降序；分页改为「加载更多」。不显示总条数、页码或「本页 N 条」。

### 3.1 线框

```text
┌──────────────────────────────────────────────────────────────────────┐
│① [全部任务|我负责的]  [🔍 搜索任务…      ] [状态 ▾] [负责人 ▾]          │
│                                          [清除筛选]   [＋ 创建任务]    │
├──────────────────────────────────────────────────────────────────────┤
│② 排序 [更新时间 ▾] [↓ 降序|↑ 升序]                                     │
├──────────────────────────────────────────────────────────────────────┤
│③ 标题 ⇅           │ 状态   │ 负责人 │ 更新时间 ↓  │ ⑥ ⧉            │
│   修复登录超时…    │ 进行中 │ 王五   │ 10-19 14:20 │ ⧉              │
│   …（已加载的条目逐批追加）                                           │
├──────────────────────────────────────────────────────────────────────┤
│④           [ 加载更多 ]   /   ✓ 已全部加载                            │
│⑤ （视觉隐藏 live region：已加载 25 条）                                │
└──────────────────────────────────────────────────────────────────────┘
```

1. 筛选栏：沿用现有 ToggleButtonGroup + 搜索 + 状态 Select，新增「负责人」Select。本期无跨项目视图，**不提供「项目」筛选**（O2）。有任一筛选生效时显示「清除筛选」（`Button variant="ghost"`）。
2. 排序控件：
   - 字段 `Select`（`aria-label="排序字段"`）：仅「更新时间」(`updated_at`)、「标题」(`title`)。
   - 方向 `ToggleButtonGroup selectionMode="single" disallowEmptySelection`（`aria-label="排序方向"`）：「降序」「升序」，带 ↓/↑ 图标 + 文字。
   - **始终有一项选中**，默认「更新时间 降序」。不存在「无排序 / 默认顺序」选项。
3. 表格：HeroUI `Table`。「标题」「更新时间」两列表头**可点击**（`<button>` 置于 `<th>` 内，accessible name「按标题排序」/「按更新时间排序」）：点当前排序列 → 切换方向；点另一列 → 切到该列，方向取该列默认（更新时间=降序，标题=升序）。表头点击与 ② 控件双向同步。当前排序列的 `<th>` 设 `aria-sort="descending"|"ascending"`，**其他列不设 aria-sort**（不写 `none`，避免读屏噪音）；状态、负责人列不可排序。
4. 「加载更多」：`Button variant="secondary"`，居中，宽度不定（`min-w-40 px-4`）。`next_cursor` 为 null 时替换为静态文字「已全部加载」（`text-sm text-muted`，前置 ✓ 图标 `aria-hidden`）。
5. live region：`<div role="status" aria-live="polite" class="sr-only">`，见 3.3。
6. 行内「复制链接」图标按钮，见 §4。

### 3.2 URL 与请求

- 前端**每次请求都显式传** `sort` 与 `order`，并写入 URL：`/projects/:pid/tasks?status=IN_PROGRESS&owner=me&q=登录&sort=updated_at&order=desc`。
- URL 缺少或含非法 `sort/order` 时，前端规范化为 `sort=updated_at&order=desc` 并 `replaceState` 写回，不依赖后端默认顺序。
- **游标不写入 URL**（「加载更多」累积的是会话内状态）；刷新/打开分享链接时从第一批重新加载（与 US-12 一致：复现的是同一筛选与排序视图，而非同一滚动位置）。
- 每批 `limit=25`（沿用现有值）。

### 3.3 状态与交互

| 状态 | 表现 | 焦点 / 播报 |
|---|---|---|
| 首次加载 | 表格 5 行骨架（Tailwind `animate-pulse`，`motion-reduce:animate-none`），容器 `aria-busy="true"`；筛选与排序可用 | 不移动焦点；完成后播报「已加载 N 条」 |
| 空（无任务） | `Empty`「还没有任务」+「＋ 创建任务」（仅 MEMBER/ADMIN） | 播报「没有任务」 |
| 空（筛选无结果） | `Empty`「没有符合条件的任务」+「清除筛选」 | 播报「没有符合条件的任务」 |
| 首批出错 | `Message`（Alert danger）+「重试」；保留筛选与排序 | Alert `role="alert"` |
| 加载更多中 | 按钮 `isDisabled` + `aria-busy`，显示 Spinner +「正在加载…」，已加载条目不变 | 焦点留在按钮上（禁用时仍可聚焦：用 `aria-disabled` 而非原生 disabled） |
| 加载更多成功 | 新条目追加到末尾；按钮回到「加载更多」或变为「已全部加载」 | **焦点移到新一批的第一行的标题链接**（便于继续浏览，不需回滚）；live 播报「已加载 N 条」（N=本批条数）。若已无更多（next_cursor 为空），额外播报「已全部加载」，焦点仍移到新批首行 |
| 加载更多出错 | **已加载条目全部保留**；按钮上方行内 `Alert status="danger"`「加载失败」+ 按钮文字变「重试加载」 | 焦点留在按钮（即「重试加载」）；Alert `role="alert"` 播报 |
| 最后一页 | 「已全部加载」 | 见上 |

**重置规则（排序或筛选变化）**：

1. 立即**丢弃当前游标与已加载条目**，中止（AbortController）在途请求，用新参数从第一批请求；写 URL（筛选、排序变更用 `pushState`，搜索输入用 `replaceState`）。
2. 过渡：表格保留旧数据但 `opacity-60` + 顶部不确定态 `ProgressBar`（`aria-label="正在更新列表"`），避免闪白；新数据到达后整体替换。
3. 焦点保持在触发的控件上（Select / 方向切换 / 表头按钮），不跳动；新数据完成后播报「已加载 N 条」。
4. 搜索输入沿用 250ms 防抖；Esc 清空。

**INVALID_CURSOR（400）处理**：说明前端持有的游标与当前排序/筛选不匹配（理论上已被第 1 条规则避免，属兜底）。处理：静默丢弃游标与已加载条目，用当前参数从第一批重新加载一次，并显示一次性 `Alert status="warning"`「列表条件已变化，已从头重新加载」（`role="status"`）；若重新加载后仍返回 INVALID_CURSOR，按首批出错处理，不再自动重试（避免循环）。

### 3.4 文案

| key（zh-CN） | en-US | ru-RU | ru 余量建议 |
|---|---|---|---|
| 负责人 | Owner | Ответственный | 不定宽，+60% |
| 全部负责人 | All owners | Все ответственные | Select `min-w-48` |
| 排序 | Sort | Сортировка | — |
| 排序字段 | Sort by | Поле сортировки | 仅 aria |
| 排序方向 | Sort direction | Направление сортировки | 仅 aria |
| 更新时间 | Updated | Дата обновления | 表头允许换行，+80% |
| 标题 | Title | Название | — |
| 降序 | Descending | По убыванию | ToggleButton 不定宽，+60% |
| 升序 | Ascending | По возрастанию | 同上 |
| 按更新时间排序 | Sort by updated time | Сортировать по дате обновления | 仅 aria |
| 按标题排序 | Sort by title | Сортировать по названию | 仅 aria |
| 清除筛选 | Clear filters | Сбросить фильтры | +40% |
| 加载更多 | Load more | Загрузить ещё | +40%，不定宽 |
| 正在加载… | Loading… | Загрузка… | 按钮宽度按最长态预留 `min-w` |
| 已加载 {count} 条 | Loaded {count} more | Загружено: {count} | 仅 live |
| 已全部加载 | All tasks loaded | Все задачи загружены | +60% |
| 加载失败 | Couldn't load more tasks | Не удалось загрузить задачи | 2 行 |
| 重试加载 | Try again | Повторить загрузку | +80% |
| 正在更新列表 | Updating list | Обновление списка | 仅 aria |
| 列表条件已变化，已从头重新加载 | The list changed, so it was reloaded from the start. | Условия списка изменились, список загружен заново. | 2 行 |
| 正在加载任务 | Loading tasks | Загрузка задач | — |
| 还没有任务 | No tasks yet | Задач пока нет | — |
| 创建第一个任务，开始协作。 | Create the first task to get started. | Создайте первую задачу, чтобы начать работу. | 2 行 |
| 没有符合条件的任务 | No tasks match your filters | Нет задач, соответствующих фильтрам | 2 行 |
| 任务加载失败 | Couldn't load tasks | Не удалось загрузить задачи | — |
| 重试 | Retry | Повторить | — |

（不使用任何暗示后端默认顺序的表述，也不显示总数、页码或按页计数。）

### 3.5 无障碍要点

- `Table` `aria-label="任务列表"`；仅当前排序列 `aria-sort`；表头排序按钮 ≥ 24×24，焦点可见。
- live region 只在一批数据落定后更新一次，避免每次按键播报；首批与追加批统一「已加载 N 条」。
- 「加载更多」使用 `aria-disabled` 保持可聚焦，防止加载中焦点丢到 `<body>`；焦点移到新批首行时该行须在视口内且不被吸顶栏遮挡（2.4.11，`scroll-padding-top`）。
- 不用无限滚动（避免键盘用户无法到达页脚、2.1.1）；小屏折叠为卡片列表时规则相同。

### 3.6 Nielsen 检查

| # | 结论 |
|---|---|
| 1 系统状态可见 | 骨架、按钮加载态、「已加载 N 条」、「已全部加载」 ✔ |
| 2 贴近现实 | 「更新时间 / 标题 + 升降序」直白，不暗示无业务含义的顺序 ✔ |
| 3 控制与自由 | 清除筛选、浏览器后退、排序始终可切换 ✔ |
| 4 一致性 | 表头点击与排序控件双向同步 ✔ |
| 5 防错 | 条件变化即丢弃游标；INVALID_CURSOR 兜底且不循环 ✔ |
| 6 识别而非回忆 | 排序始终有可见选中项；`aria-sort` ✔ |
| 7 灵活高效 | URL 可收藏排序与筛选；表头快捷排序 ✔ |
| 8 简约 | 无页码、无总数 ✔ |
| 9 错误恢复 | 加载更多失败保留已加载条目 + 重试 ✔ |
| 10 帮助 | 空态说明 ✔（Nice to have：帮助页补充排序说明） |

---

## 4. 深链接、复制链接、无权限与链接失效（US-12）

### 4.1 URL 约定（设计侧建议，最终以实现为准）

- 列表：`/projects/:pid/tasks?status=IN_PROGRESS&owner=me&q=登录&sort=updated_at&order=desc`（游标不进 URL，见 §3.2）
- 详情：`/projects/:pid/tasks/:taskID`（现有），从列表进入时附带 `?from=` 不必要——返回按钮使用 history；直接打开时「返回任务列表」指向不带筛选的列表。
- 不可识别的路由（未知 page 段如 `/projects/x/foo`、ID 解码失败、多余路径段）**不再自动跳回概览**，改为显示「链接失效」页（O4 已解决），见 §4.3a。

### 4.2 线框：详情 + 复制链接

```text
┌──────────────────────────────────────────────────────────────┐
│① 项目 A › 任务 › 修复登录超时                [⧉ 复制链接] ②   │
├──────────────────────────────────────────────────────────────┤
│③ 任务详情（直接加载，加载中显示骨架）                          │
│                                     ┌──────────────────────┐ │
│                                     │④ ✓ 链接已复制         │ │
│                                     └──────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

1. 面包屑（`<nav aria-label="面包屑">`），末项 `aria-current="page"`。
2. 「复制链接」`Button variant="secondary"`，带图标与文字；列表行内为图标按钮。
3. 直接通过链接进入：先渲染页面骨架 + 侧栏。登录后回跳原路径**已实现**（`main.tsx` 以 `state.returnTo = location.pathname` 回跳）；本期**唯一增量**：`returnTo` 同时保留 `location.search` 与 `location.hash`，使筛选视图（query）与锚点在登录后恢复（O5）。开发模式的 `returnTo` 查询参数同理。仍沿用现有同源相对路径校验。
4. 复制反馈：按钮文字 2 秒内变为「已复制」+ ✓，同时 `role="status"` 播报；剪贴板不可用（非安全上下文）时弹出 Modal，内含只读 Input 已全选链接 + 提示「按 Ctrl+C 复制」。

### 4.3 线框：无权限 / 链接失效（同一模板）

```text
┌──────────────────────────────────────┐
│              ① [图标 🔒 / ⛓]          │
│   ② 你没有查看此任务的权限             │
│   ③ 说明：请联系项目管理员把你加入…    │
│   ④ [返回任务列表]  [复制链接以便申请] │
│   ⑤ 错误编号：trace-id（可选择复制）   │
└──────────────────────────────────────┘
```

- 使用 `Empty` 卡片（图标 `aria-hidden`），标题为 `<h1>`，页面 `document.title` 同步。
- 按后端实际行为区分（O6 已确认）：
  - **404**（资源不存在、项目不存在，或**不是该项目成员**）→「找不到或无权访问」页：不透露资源是否存在，引导联系管理员或检查链接。
  - **403**（是项目成员，但角色不足）→「权限不足」页：明确告知需要的角色，引导联系项目管理员调整角色。
  - ID 解码失败、未知 page 段（前端判定，不请求后端）→「链接失效」页（§4.3a）。
- 进入此页时焦点移到 `<h1>`（`tabIndex=-1`）。

### 4.3a 「链接失效」页（O4）

```text
┌──────────────────────────────────────┐
│              ① [⛓ 断链图标]           │
│   ② 链接失效                          │
│   ③ 这个链接的地址不正确或已不再可用。 │
│   ④ [返回项目概览]（primary）          │
└──────────────────────────────────────┘
```

1. 图标 `aria-hidden`；② `<h1 tabIndex=-1>`，进入时获得焦点，`document.title` 同步。
2. 说明 `max-w-prose`。
3. 「返回项目概览」`Button variant="primary"`（渲染为链接 `<a href="/projects/:pid/overview">`）；项目 ID 本身无法解析时指向 `/`。URL **保持原样**不被改写（便于用户复制给管理员排查），不做任何自动跳转。

- 与 §4.3 共用 `Empty` 卡片模板，侧栏与顶栏照常显示。

### 4.4 状态

| 状态 | 表现 |
|---|---|
| 加载 | 详情骨架，`aria-busy` |
| 成功 | 详情 + 复制链接 |
| 403 权限不足 | 模板 4.3（锁图标） |
| 404 找不到或无权访问 | 模板 4.3（问号图标） |
| 前端路由无法识别 | 「链接失效」页 §4.3a |
| 网络错误 | `Message` + 重试（不当作失效） |

### 4.5 文案

| zh-CN | en-US | ru-RU | ru 余量 |
|---|---|---|---|
| 复制链接 | Copy link | Копировать ссылку | +60%，不定宽 |
| 复制任务链接：{title} | Copy link to task: {title} | Копировать ссылку на задачу: {title} | 仅 aria |
| 已复制 | Copied | Скопировано | 按钮宽度按最长态保留（`min-w`），防止跳动 |
| 链接已复制到剪贴板 | Link copied to clipboard | Ссылка скопирована в буфер обмена | live 播报 |
| 无法自动复制，请按 Ctrl+C 复制链接 | Couldn't copy automatically. Press Ctrl+C to copy the link. | Не удалось скопировать автоматически. Нажмите Ctrl+C, чтобы скопировать ссылку. | 2 行 |
| 找不到或无权访问（404） | Not found or no access | Не найдено или нет доступа | 标题允许 2 行 |
| 链接可能已失效，或你不是该项目的成员。请检查链接，或联系项目管理员。（404） | The link may be invalid, or you may not be a member of this project. Check the link or contact a project admin. | Возможно, ссылка недействительна или вы не участник этого проекта. Проверьте ссылку или обратитесь к администратору проекта. | 3 行预算，`max-w-prose` |
| 权限不足（403） | You don't have permission | Недостаточно прав | — |
| 你是该项目成员，但当前角色无法执行此操作。请联系项目管理员调整角色。（403） | You're a member of this project, but your role doesn't allow this. Ask a project admin to change your role. | Вы участник проекта, но ваша роль не позволяет это действие. Попросите администратора проекта изменить роль. | 3 行预算 |
| 链接失效 | Link not valid | Ссылка недействительна | 标题 |
| 这个链接的地址不正确或已不再可用。 | This link address is incorrect or no longer available. | Адрес ссылки неверен или больше недоступен. | 2 行 |
| 返回项目概览 | Back to project overview | Вернуться к обзору проекта | +80%，不定宽 |
| 返回任务列表 | Back to tasks | Вернуться к задачам | +40% |
| 错误编号 | Error ID | Код ошибки | — |

### 4.6 无障碍

- 复制按钮在「已复制」态仍保持同一 accessible name 前缀，避免焦点丢失；播报走独立 live region。
- 提示页按钮最小 `h-10`（40px）。

### 4.7 Nielsen

1 ✔ 复制即时反馈；3 ✔ 返回列表；4 ✔ 两种提示页同模板；5 ✔ 区分网络错误与失效，避免误导；9 ✔ 说明原因 + 下一步；10 ✔ trace 便于求助。其余项无特殊问题。

---

## 5. 写操作超时、重试、「已成功无需重复」（US-13b）

### 5.1 判定（与 api.ts 对齐）

| 情况 | 识别 | UI |
|---|---|---|
| 超时 | `AbortSignal.timeout(20000)` 抛 `TimeoutError` / 网络中断 / 5xx | 警告态「结果未知」+ 重试（复用同一 Idempotency-Key） |
| 重试返回幂等命中 | 2xx 且响应头 **`Idempotency-Replayed: true`**（后端新增，O7 已确认） | 成功态「已成功，无需重复提交」——**仅以该响应头为准**，前端不做推断 |
| 重试正常成功 | 2xx 且无该响应头 | 普通成功（即使是重试，也说明此前确未成功） |
| 同 key 不同内容 | 409 `IDEMPOTENCY_CONFLICT` | 沿用 `Message` 错误 |
| 4xx | — | 沿用 `Message` 错误 |

### 5.2 线框

```text
┌ 创建任务（Modal）──────────────────────────────┐
│ 标题 [……]   描述 [……]                         │
│ ┌─────────────────────────────────────────────┐ │
│ │① ⚠ 请求超时，暂不确定是否已保存               │ │
│ │  重试是安全的，不会重复创建。                 │ │
│ │  [② 重试]  [③ 在任务列表中查看]               │ │
│ └─────────────────────────────────────────────┘ │
│                           [取消] [④ 处理中… ⟳] │
└─────────────────────────────────────────────────┘
成功后：
┌─────────────────────────────────────────────────┐
│⑤ ✓ 已成功，无需重复提交。该任务此前已创建。 [打开任务] │
└─────────────────────────────────────────────────┘
```

1. `Alert status="warning"`，容器 `role="status" aria-live="polite"`（非 alert，避免打断）；表单内容**不清空**（3.3.7 冗余输入）。
2. 「重试」`Button variant="primary"`，点击后焦点留在按钮，按钮进入「处理中…」。
3. 次要动作 `variant="tertiary"`：去列表核实。
4. 提交按钮沿用 `Form` 的 busy 态；超过 5 秒仍在等待时，按钮下方追加「仍在处理，请勿关闭页面」（`role="status"`）。
5. `Alert status="success"`，显示 4 秒以上且不自动消失于焦点区域（2.2.1 无时限要求：成功提示不自动关闭，或在 Modal 关闭后转为 Toast）。

### 5.3 状态

加载（处理中）/ 超时（警告 + 重试）/ 重试中 / 成功 / 幂等成功（已成功无需重复）/ 失败（danger）。连续 3 次超时后改为提示「服务暂时不可用，请稍后再试」并保留重试。

### 5.4 文案

| zh-CN | en-US | ru-RU | ru 余量 |
|---|---|---|---|
| 请求超时，暂不确定是否已保存 | The request timed out. We can't confirm it was saved. | Время ожидания истекло. Не удалось подтвердить сохранение. | 2–3 行 |
| 重试是安全的，不会重复创建。 | Retrying is safe and won't create duplicates. | Повторить безопасно: дубликаты не появятся. | — |
| 在任务列表中查看 | Check the task list | Проверить список задач | +40% |
| 仍在处理，请勿关闭页面 | Still working. Please keep this page open. | Обработка продолжается. Не закрывайте страницу. | — |
| 已成功，无需重复提交 | Already done — no need to submit again | Уже выполнено, повторять не нужно | 标题 2 行 |
| 该操作此前已成功完成。 | This action had already succeeded. | Это действие уже было выполнено. | — |
| 打开任务 | Open task | Открыть задачу | — |
| 服务暂时不可用，请稍后再试 | The service is temporarily unavailable. Try again later. | Сервис временно недоступен. Повторите попытку позже. | — |

### 5.5 无障碍

- 警告/成功提示用 live region 播报，且出现时**不抢焦点**；危险错误沿用 `role=alert`。
- 颜色之外用图标 + 标题文字区分 warning/success。
- 重试按钮 ≥ 40px 高。

### 5.6 Nielsen

1 ✔ 明确「结果未知」而非笼统失败；5 ✔ 幂等 key 防重复，文案告知安全；9 ✔ 给出两个恢复路径；3 ✔ 可取消；2 ✔ 「已成功，无需重复」直接回答用户疑虑。

---

## 6. 日常管理（US-14、US-14b、US-15）

> v3.3 起对齐 PRD v5；**v3.4** 闭合审核 must-fix：有限只读、`is_org_admin`、双 active 字段、Tab 路由 MVP、`LAST_ORG_ADMIN`、创建项目鉴权扩展说明。

### 6.0 角色呈现：组织 ADMIN vs 项目 ADMIN

| 角色 | 如何识别（**已关闭 C1**） | 界面呈现 |
|---|---|---|
| **组织 ADMIN** | `GET /me`（或等价会话引导接口）返回布尔 **`is_org_admin: true`**；由种子/bootstrap 授予首个组织 ADMIN。**本期不做**授予/撤销 UI。识别**不得**用「任一项目含 ADMIN」推断 | 顶栏 Chip「组织管理员」；管理区可见「组织账号」Tab |
| **项目 ADMIN** | 当前项目 `roles` 含 `ADMIN` | 顶栏 Chip「项目管理员」；本项目成员 Tab **可写**（添加 / 从本项目停用） |
| 同时具备两者 | `is_org_admin` 且本项目 `ADMIN` | 顶栏 **并排**两枚 Chip，**组织管理员在左**；两套入口均可用 |
| 仅项目 ADMIN、非组织 ADMIN | `is_org_admin !== true` | **不显示**「组织账号」Tab 与「停用账号」；`?tab=org-accounts` 直链 → 403（§4.3） |
| MEMBER / REVIEWER | — | 侧栏「管理」**隐藏**；直链 → 无权限页 |

**鉴权硬约束（Must，对接 C6 / 审核 M4）**：账号级停用写接口**仅**接受组织 ADMIN。**禁止**复用现网 `executeOrganization` /「任一项目 ADMIN」门槛（与 `registerHuman` **故意不对称**）。集成测试必覆盖：仅项目 ADMIN → 403，且 `human_users.active` 未变。

**防混淆原则（Must）**：

1. 项目成员表操作列**只出现「从本项目停用」**，永不出现「停用账号」。
2. 「停用账号」**只出现在「组织账号」Tab**，文案明确「无法登录」。
3. 两种确认对话框标题、主按钮、说明互不复用。
4. 空状态写清边界；组织账号空态仅组织 ADMIN 可见。

### 6.1 信息架构

管理区位于现网路径 **`/projects/:pid/management`**，四 Tab（文案不定宽，ru 下可横向滚动）。组织账号用查询参数切换：**`?tab=org-accounts`**（M5 MVP，**已关闭 C5**）。独立 pathname `/organization/accounts` 标为**后续可选**（需改 `routing.ts` + OIDC returnTo，不阻塞 M5）。

| Tab | 可见条件 | 故事 |
|---|---|---|
| 成员（本项目） | 本项目 **项目 ADMIN**，**或**（`is_org_admin` 且为本项目成员） | US-14 |
| **组织账号** | **仅** `is_org_admin === true`（Tab 不在非组织 ADMIN 的 DOM 中） | US-14b |
| 项目 | 任一项目 ADMIN **或** 组织 ADMIN | US-15 |
| 仓库 | 当前项目 ADMIN | US-15 |

#### 本项目成员 Tab 能力（Weh 已确认 C2 = **有限只读**；与上表可见条件统一）

| 调用方 | 成员 Tab | 添加 / 从本项目停用 |
|---|---|---|
| 本项目 `roles` 含 `ADMIN` | 显示 | **可写** |
| `is_org_admin` 且为本项目成员，但**非**项目 ADMIN | 显示 | **有限只读**：可看列表与筛选；**隐藏**写按钮；顶部 `Alert`「你是组织管理员，对本项目成员为只读。」（`role=status`） |
| `is_org_admin` 但**不是**本项目成员 | 不进入该项目上下文（现网非成员 → 404） | —；仍可通过其他已加入项目的 management 打开「组织账号」Tab |
| 非 ADMIN 成员 / REVIEWER | 无「管理」入口 | 直链 → 无权限 |

权限矩阵（写操作）：

| 元素 | 组织 ADMIN | 仅项目 ADMIN | MEMBER/REVIEWER |
|---|---|---|---|
| 「组织账号」Tab /「停用账号」 | 显示、可操作 | **隐藏**（`?tab=org-accounts` → 403） | 隐藏 |
| 本项目：添加 / 从本项目停用 | **仅当亦为该项目 ADMIN**；否则只读（上表） | 可 | 直链无权限 |
| 项目：创建 | **可**（**已关闭 C3**；须扩展后端 createProject / `executeOrganization` 鉴权为「组织 ADMIN **或** 任一项目 ADMIN」。现网仅「任一项目 ADMIN」，纯组织 ADMIN 今日会 403） | 可（现状） | — |
| 项目：归档 / 恢复 | 可（若具备项目 ADMIN；否则只读项目列表【假设同 C2】） | 本项目可 | — |
| 仓库登记 | 本项目 ADMIN 时可 | 本项目可 | — |
| 已归档项目 | 写按钮隐藏；只读 Alert +「恢复项目」（项目 ADMIN） | | |

原则：无权操作**隐藏**而非禁用；维护模式等暂不可用时用禁用 + `aria-describedby`。

### 6.2 本项目成员列表与添加（US-14）

```text
┌ 成员（本项目） ─────────────────── [＋ 添加成员]① ┐
│  ⓘ 只读条（仅有限只读时显示）                      │
│② [🔍 搜索]  [状态：全部/启用/已停用 ▾]              │
│③ 姓名 │ 邮箱 │ 角色 │ 成员状态 │ 账号 │ 操作        │
│  张三 │ …    │ 项目ADMIN│ 启用 Chip│ —  │ [从本项目停用]④│
│  李四 │ …    │ 成员    │ 已停用   │ —  │ —            │
│  王五 │ …    │ 成员    │ 启用     │ 账号已停用 Chip│ — │
└────────────────────────────────────────────────────┘
```

1. 添加成员 → Modal（**仅项目 ADMIN**）：邮箱/身份标识*、显示名、角色、操作原因*。有限只读时不渲染此按钮。
2. 搜索 + 状态筛选（按 **membership** 状态）。
3. Table；角色 `Badge`。**禁止**再使用合成单一 `active`（现网 `m.active AND u.active`）。API/UI 必须拆分（**已关闭 C4**）：
   - `membership_active` → Chip「启用」/「已停用」（本项目成员资格）
   - `account_active` → 仅当 `false` 时显示独立 Chip「账号已停用」（danger soft）；为 `true` 时该列为空或「—」
4. 「从本项目停用」仅当：调用方为项目 ADMIN，且 `membership_active===true`，且 `account_active!==false`，且非自己。`account_active===false` 时隐藏该按钮（账号级已停用，项目级操作无意义）。409 `LAST_ADMIN` → §6.3a。**禁止**在此列放「停用账号」。

### 6.3 本项目停用二次确认（US-14）

```text
┌ 从本项目停用 张三？ ─────────────────────┐
│ 仅停用其在本项目的访问，并立即吊销其在本项  │
│ 目委托的 Agent 会话；不影响其在其他项目的成 │
│ 员身份；其已负责的任务不会自动转交。        │
│ ⓘ 张三名下有 3 个未完成任务，可先通过        │
│   任务交接（D07）处理。[查看这些任务]        │
│ 操作原因 * [_______________________]        │
│                 [取消]  [从本项目停用]      │
└────────────────────────────────────────────┘
```

- 确认说明**逐字**采用 PRD UI 需求第 4 项给定句（不得写成「无法登录」「登录会话失效」）。
- `ConfirmModal`：`role="alertdialog"`，`isDismissable=false`；打开焦点→原因输入；Esc=取消；关闭后焦点回触发按钮。
- 未完成任务提示（O10，**假设**）：有低成本计数则显示「{name} 名下有 {count} 个未完成任务」+ 链到 `/projects/:pid/tasks?owner={id}`；拿不到则降级为「如其名下有未完成任务，请先通过任务交接（D07）处理。」；计数失败不阻塞停用；0 条不显示提示。
- 成功：关对话框，行状态「已停用」，`role=status`「已从本项目停用 {name}」。失败/超时同 §5；对话框内显示错误。

### 6.3a 409 `LAST_ADMIN`（项目级）

- 对话框不关闭；说明下方 `Alert status="danger"`（`role="alert"`）；「从本项目停用」禁用；焦点→「取消」。不做乐观更新。文案见 §6.8。

### 6.4 组织账号与账号级停用（US-14b）【本期 M5】

#### 6.4.1 入口与路由（**已关闭 C5**）

- **M5 MVP**：在 `/projects/:pid/management` 内增加 Tab「组织账号」；深链与刷新使用 **`?tab=org-accounts`**（`pushState`/`replaceState` 与现网一致）。侧栏文案可叫「组织账号」，实际仍落在 management 页，**不**挂在成员行上。
- **后续可选**：独立 `/organization/accounts`（需扩展 `routing.ts` + OIDC returnTo）；本期不实现、不阻塞。
- 非组织 ADMIN：Tab **不进入 DOM**；访问 `?tab=org-accounts` → 403 页（§4.3），说明「账号级停用仅组织管理员可操作。」
- **鉴权**：前端以 `me.is_org_admin` 控制可见性；写操作成功与否以后端「仅组织 ADMIN」为准，**不得**因调用方是项目 ADMIN 就发出停用请求。

#### 6.4.2 线框

```text
┌ 组织账号 ──────────────────────────────────────────┐
│① [🔍 搜索姓名或邮箱]  [状态：全部/启用/账号已停用 ▾] │
│② 姓名 │ 邮箱 │ 组织角色 │ 账号状态 │ 操作           │
│  张三 │ …    │ 组织管理员│ 启用     │ [停用账号]③   │
│  王五 │ …    │ —        │ 启用     │ [停用账号]     │
│  赵六 │ …    │ —        │ 账号已停用│ —             │
└────────────────────────────────────────────────────┘
```

1. 列表来源（**已关闭 C6**）：优先扩展现网 **`GET /organization/members`**（返回账号态 `active` / `account_active`，及是否组织 ADMIN）；避免平行的 `/organization/users` 除非合同另有强理由。状态筛选用「账号已停用」，不用「已停用」（以免与 membership 混淆）。
2. 组织角色列：`is_org_admin` 用户显示 Chip「组织管理员」；其他人「—」。
3. 「停用账号」`Button variant="danger"` size sm。自己的行不显示。`account_active===false` 行无操作。
4. **写路径**：`POST /api/v1/organization/members/{user}/changes`（body: `active:false` + `reason`，`Idempotency-Key`）或显式 `.../deactivate`。鉴权 **仅组织 ADMIN**——**禁止**复用「任一项目 ADMIN」的 `executeOrganization` 门槛。成功须审计，并吊销该用户委托的 Agent/MCP 会话（全项目范围，以实现为准）。
5. **本期不做**：账号级「恢复启用」、授予/撤销组织 ADMIN UI（种子授予，C1）。
6. 409 **`LAST_ORG_ADMIN`**：见 §6.4.4。

#### 6.4.3 二次确认

```text
┌ 停用账号 张三？ ─────────────────────────┐
│ ⚠ 这是账号级停用。                        │
│ 停用后，张三将无法登录控制台，也无法调用  │
│ API；其在所有项目中的访问立即失效，并吊销 │
│ 其委托的 Agent/MCP 会话。此操作写入审计。 │
│ 操作原因 * [_______________________]      │
│                    [取消]  [停用账号]      │
└──────────────────────────────────────────┘
```

- 标题与主按钮必须含「停用账号」；首行警示「这是账号级停用。」（颜色 warning soft + 图标，不单靠颜色）。
- 确认说明允许并应含「无法登录」（账号级语义，PRD 已确认）。
- 焦点/原因必填/Esc 规则同 §6.3。
- 成功：关对话框，行状态→「账号已停用」，`role=status`「已停用账号 {name}」；若用户同时打开某项目成员页，该页应在下次刷新显示「账号已停用」Chip。
- 失败：403 → 对话框内 Alert「你没有组织管理员权限」；**409 `LAST_ORG_ADMIN`** → §6.4.4；其他错误同 `Message`；超时同 §5。
- 与项目级对话框**视觉区分**：账号级对话框标题左侧加警示图标；项目级无此图标。

#### 6.4.4 409 `LAST_ORG_ADMIN`（账号级，对齐 §6.3a）

- 后端禁止停用最后一名组织 ADMIN 时返回 **409 `LAST_ORG_ADMIN`**。
- UI：对话框**不关闭**；说明下方 `Alert status="danger"`（`role="alert"`）；「停用账号」按钮禁用；焦点移到「取消」；原因字段保留；不做乐观更新。
- 文案见 §6.8。

#### 6.4.5 状态

| 状态 | 表现 |
|---|---|
| 空 | `Empty`「没有可管理的组织账号」 |
| 加载 | 表格骨架 |
| 出错 | `Message` + 重试 |
| 成功停用 | 行更新 + live 播报；已打开的项目成员页下次进入/刷新后显示「账号已停用」Chip（Nice：可 invalidate） |
| `LAST_ORG_ADMIN` | §6.4.4 |
| 非组织 ADMIN 直链 / 错 Tab | 403 页 |

### 6.5 项目创建、归档与恢复（US-15）

- 项目 Tab：表（名称、状态、创建时间、操作），右上「＋ 创建项目」。
- 「归档」→ 普通二次确认（无需输入项目名，O9）。
- **归档被阻塞**（后端拒绝，存在未完成工作）：对话框不关闭，显示 `Alert status="warning"`「无法归档」+ 阻塞项列表（任务 / run / 工具调用，最多 20 条，超出显示「以及其他 N 项」）；每项可链到详情（若有深链）。焦点→列表或「取消」。
- 归档后 Chip「已归档」；筛选「进行中 / 已归档 / 全部」。
- **恢复**：① 已归档视图行操作「恢复」；② 项目内只读 Alert 右侧「恢复项目」。确认对话框非危险态，原因必填。

### 6.6 仓库登记表单（US-15）

```text
┌ 登记仓库 ──────────────────────────────┐
│ 仓库地址 *  [owner/repo 或完整 GitHub URL] │
│ 默认分支    [main]                       │
│ 操作原因 *  [___________]                 │
│                       [取消] [登记仓库]   │
└────────────────────────────────────────┘
```

字段级错误：`FieldError` + `aria-invalid` / `aria-describedby`。

### 6.7 状态总表

| 界面 | 空 | 加载 | 错误 | 成功 |
|---|---|---|---|---|
| 本项目成员 | 「只有你一个成员」+ 添加 | 骨架 | Message + 重试 | 行更新 + 播报 |
| 组织账号 | 「没有可管理的组织账号」 | 骨架 | Message + 重试 / 403 页 | 行更新 + 播报 |
| 项目 | 「还没有项目」+ 创建 | 骨架 | Message；归档阻塞列清单 | 高亮新行 / 恢复播报 |
| 仓库 | 「此项目还没有登记仓库」 | 骨架 | 字段/表单错误 | 列表新增 |
| 无权限 | §4.3 | — | — | — |

### 6.8 文案（含 US-14 / US-14b）

| zh-CN | en-US | ru-RU | ru 余量 |
|---|---|---|---|
| 成员（本项目） | Members (this project) | Участники (этот проект) | Tab +80% |
| 组织账号 | Organization accounts | Учётные записи организации | Tab +100% |
| 组织管理员 | Organization admin | Администратор организации | Chip 不定宽 |
| 项目管理员 | Project admin | Администратор проекта | Chip 不定宽 |
| 添加成员 | Add member | Добавить участника | +60% |
| 从本项目停用 | Deactivate in this project | Деактивировать в этом проекте | +100%，允许换行 |
| 从本项目停用 {name}？ | Deactivate {name} in this project? | Деактивировать {name} в этом проекте? | 标题 2 行 |
| 仅停用其在本项目的访问，并立即吊销其在本项目委托的 Agent 会话；不影响其在其他项目的成员身份；其已负责的任务不会自动转交。 | This only removes their access to this project and immediately revokes the Agent sessions they delegated in this project. Their membership in other projects isn't affected, and tasks they own won't be reassigned automatically. | Будет отключён только доступ к этому проекту, а сеансы агентов, делегированные участником в этом проекте, будут сразу отозваны. Участие в других проектах сохранится, а задачи участника не будут переназначены автоматически. | 4–5 行，`max-w-prose` |
| {name} 名下有 {count} 个未完成任务，可先通过任务交接（D07）处理。 | {name} owns {count} open tasks. You can hand them off first (D07). | Открытых задач у участника {name}: {count}. Сначала их можно передать (D07). | 2–3 行 |
| 如其名下有未完成任务，请先通过任务交接（D07）处理。 | If they own open tasks, hand them off first (D07). | Если у участника есть открытые задачи, сначала передайте их (D07). | 2 行 |
| 查看这些任务 | View these tasks | Показать эти задачи | +60% |
| 已从本项目停用 {name} | {name} deactivated in this project | {name} деактивирован(а) в этом проекте | — |
| 启用 / 已停用 | Active / Deactivated | Активен / Деактивирован | 本项目 membership |
| 账号已停用 | Account deactivated | Учётная запись отключена | Chip +80% |
| 停用账号 | Deactivate account | Отключить учётную запись | +100% |
| 停用账号 {name}？ | Deactivate account {name}? | Отключить учётную запись {name}? | 标题 2 行 |
| 这是账号级停用。 | This is an account-level deactivation. | Это отключение учётной записи. | 警示行 |
| 停用后，{name} 将无法登录控制台，也无法调用 API；其在所有项目中的访问立即失效，并吊销其委托的 Agent/MCP 会话。此操作写入审计。 | After this, {name} won't be able to sign in to the console or call the API. Access is revoked in all projects, and their delegated Agent/MCP sessions are revoked. This is recorded in the audit log. | После этого {name} не сможет войти в консоль и вызывать API. Доступ ко всем проектам будет сразу закрыт, а делегированные сеансы Agent/MCP отозваны. Действие записывается в журнал аудита. | 4–5 行 |
| 已停用账号 {name} | Account {name} deactivated | Учётная запись {name} отключена | — |
| 账号级停用仅组织管理员可操作。 | Only organization admins can deactivate accounts. | Отключать учётные записи могут только администраторы организации. | 403 说明 |
| 你没有组织管理员权限 | You don't have organization admin permission | У вас нет прав администратора организации | — |
| 没有可管理的组织账号 | No organization accounts to manage | Нет учётных записей организации | — |
| 无法停用最后一名管理员（409 LAST_ADMIN） | Can't deactivate the last admin | Нельзя деактивировать последнего администратора | — |
| {name} 是本项目唯一的管理员。请先为其他成员授予管理员角色，再停用此成员。 | {name} is the only admin of this project. Make another member an admin first, then deactivate this member. | {name} — единственный администратор проекта. Сначала назначьте администратором другого участника, затем деактивируйте этого. | 3 行 |
| 无法停用最后一名组织管理员（409 LAST_ORG_ADMIN） | Can't deactivate the last organization admin | Нельзя отключить последнего администратора организации | 标题 2 行 |
| {name} 是唯一的组织管理员。请先将组织管理员授予他人，再停用此账号。 | {name} is the only organization admin. Grant organization admin to someone else first, then deactivate this account. | {name} — единственный администратор организации. Сначала назначьте администратора организации другому пользователю, затем отключите эту учётную запись. | 3–4 行 |
| 你是组织管理员，对本项目成员为只读。 | You're an organization admin with read-only access to this project's members. | Вы администратор организации и можете только просматривать участников этого проекта. | 2 行 |
| 成员状态 / 账号 | Membership / Account | Участие / Учётная запись | 表头 |
| 不能停用自己 | You can't deactivate yourself | Нельзя деактивировать себя | — |
| 取消 | Cancel | Отмена | — |
| 操作原因 | Reason | Причина | 复用 |
| 归档项目 | Archive project | Архивировать проект | — |
| 归档项目 {name}？ | Archive {name}? | Архивировать проект {name}? | — |
| 归档后项目变为只读，可在「已归档」中恢复。 | The project becomes read-only. You can restore it from Archived. | Проект станет доступен только для чтения. Его можно восстановить в разделе «Архив». | — |
| 无法归档 | Can't archive | Нельзя архивировать | — |
| 以下未完成工作会阻止归档： | These unfinished items block archiving: | Эти незавершённые элементы мешают архивации: | — |
| 以及其他 {count} 项 | and {count} more | и ещё {count} | — |
| 恢复 / 恢复项目 | Restore / Restore project | Восстановить / Восстановить проект | +60% |
| 恢复项目 {name}？ | Restore {name}? | Восстановить проект {name}? | — |
| 恢复后项目重新可写，成员与数据保持归档前的状态。 | The project will be writable again. Members and data stay as they were before archiving. | Проект снова станет доступен для изменений. Участники и данные останутся такими же, как до архивации. | — |
| 已恢复项目 {name} | Project {name} restored | Проект {name} восстановлен | — |
| 进行中 / 已归档 / 全部 | Active / Archived / All | Активные / Архив / Все | — |
| 项目已归档，只读 | This project is archived (read-only) | Проект в архиве (только чтение) | — |
| 登记仓库 | Register repository | Зарегистрировать репозиторий | +100% |
| 仓库地址 / 默认分支 | Repository / Default branch | Репозиторий / Основная ветка | — |
| 支持 owner/repo 或完整 GitHub 地址 | Use owner/repo or a full GitHub URL | Укажите owner/repo или полный адрес GitHub | — |
| 仓库地址格式不正确 | Enter a repository as owner/repo or a GitHub URL | Укажите репозиторий в формате owner/repo или адрес GitHub | — |
| 该仓库已登记 | This repository is already registered | Этот репозиторий уже зарегистрирован | — |
| 只有你一个成员 | You're the only member | Вы единственный участник | — |
| 此项目还没有登记仓库 | No repositories registered for this project | В проекте нет зарегистрированных репозиториев | — |

### 6.9 无障碍

- Tabs：方向键切换；「组织账号」Tab 不在 DOM 中时，非组织 ADMIN 的 Tab 列表中不出现（避免盲人发现不可用项）。
- 两种确认框均为 `alertdialog`，`aria-describedby` 指向说明；账号级对话框警示行纳入描述。
- 操作按钮 accessible name 带对象与级别：「从本项目停用 张三」「停用账号 张三」。
- 组织管理员 Chip 有文本，不单靠颜色（1.4.1）。
- 归档阻塞列表用 `<ol>`/`<ul>`，可键盘到达链接。

### 6.10 Nielsen

1 ✔ 两套停用状态可见且文案分区；2 ✔ 「从本项目停用」vs「停用账号 / 无法登录」贴近真实语义；3 ✔ 取消/Esc；4 ✔ Tab 结构一致、入口分离；5 ✔ 二次确认 + LAST_ADMIN / LAST_ORG_ADMIN + 不能停用自己 + 账号级强警示 + 有限只读；6 ✔ 角色 Chip；8 ✔ 无权限隐藏；9 ✔ 字段级与 409/403 错误；10 Should：帮助页对比两种停用。

---

## 7. GitHub 同步失败文案（US-5，可选）

沿用 `Message`（Alert danger，标题 + `code · trace`），仅确认文案：

| 场景（code 建议） | zh-CN | en-US | ru-RU |
|---|---|---|---|
| 令牌无效/未配置 | GitHub 同步失败：访问令牌无效或未配置，请联系管理员。 | GitHub sync failed: the access token is invalid or missing. Contact an admin. | Ошибка синхронизации с GitHub: токен доступа недействителен или не настроен. Обратитесь к администратору. |
| 403 权限不足 | GitHub 同步失败：令牌没有该仓库的读取权限。 | GitHub sync failed: the token can't read this repository. | Ошибка синхронизации с GitHub: у токена нет доступа на чтение к этому репозиторию. |
| 限流 | GitHub 请求过于频繁，请在 {time} 后重试。 | GitHub rate limit reached. Try again after {time}. | Превышен лимит запросов GitHub. Повторите после {time}. |
| commit/文件不存在 | 在指定 commit 中找不到该文件。 | The file wasn't found at the specified commit. | Файл не найден в указанном коммите. |
| 网络/超时 | 暂时无法连接 GitHub，可稍后重试。 | Can't reach GitHub right now. Try again later. | Не удаётся подключиться к GitHub. Повторите попытку позже. |

样式：标题一句话说明原因 + 下一步；trace 保留可选中。不在前端展示令牌任何片段。

---

## 8. 设计 Token（W3C DTCG 格式）

复用 `tokens.css`，新增/明确如下：

```json
{
  "spacing": {
    "1": { "$value": "4px", "$type": "dimension" },
    "2": { "$value": "8px", "$type": "dimension" },
    "4": { "$value": "16px", "$type": "dimension" },
    "6": { "$value": "24px", "$type": "dimension" },
    "8": { "$value": "32px", "$type": "dimension" }
  },
  "size": {
    "target-min": { "$value": "24px", "$type": "dimension", "$description": "WCAG 2.5.8 最低" },
    "target-default": { "$value": "40px", "$type": "dimension" },
    "icon-button": { "$value": "32px", "$type": "dimension" }
  },
  "color": {
    "accent": { "$value": "#445bff", "$type": "color" },
    "focus": { "$value": "{color.accent}", "$type": "color" },
    "text-muted": { "$value": "#526175", "$type": "color", "$description": "白底约 6.3:1" },
    "control-border": { "$value": "#64748b", "$type": "color", "$description": "建议值，满足 1.4.11 ≥3:1（待 O1 确认）" },
    "warning-soft-foreground": { "$value": "#785618", "$type": "color" },
    "success-soft-foreground": { "$value": "#23603e", "$type": "color" }
  },
  "duration": {
    "copy-feedback": { "$value": "2000ms", "$type": "duration" },
    "slow-hint": { "$value": "5000ms", "$type": "duration" },
    "write-timeout": { "$value": "20000ms", "$type": "duration", "$description": "与 api.ts 一致" }
  },
  "layout": {
    "button-text-reserve-ru": { "$value": 1.4, "$type": "number", "$description": "按钮按中文宽度 ×1.4 预留，且不定宽" }
  }
}
```

## 9. 组件使用汇总

| 组件 | 来源 | 用于 |
|---|---|---|
| Table | HeroUI | 任务、成员、项目、仓库列表 |
| ToggleButtonGroup / ToggleButton | HeroUI | 全部/我负责的、排序方向 |
| Select / ListBox（经 ui.tsx `Select`） | HeroUI | 状态、负责人、项目、排序、每页条数、角色 |
| TextField / Input / FieldError / Label / Description | HeroUI（ui.tsx 封装） | 搜索、表单 |
| Alert（`Message`） | HeroUI | 错误、超时 warning、成功 |
| Modal（ui.tsx）+ 新 `ConfirmModal` 变体 | HeroUI | 添加成员、创建项目、登记仓库、停用/归档确认 |
| Tabs | HeroUI | 管理页 |
| Chip（`Badge`） | HeroUI | 状态、角色 |
| Card（`Empty`） | HeroUI | 空态、无权限、链接失效 |
| Spinner / ProgressBar / Skeleton* | HeroUI | 加载（*若 3.2.5 无 Skeleton，用 Tailwind `animate-pulse`） |
| Button | HeroUI | 全部按钮（primary / secondary / tertiary / ghost / danger / danger-soft，按 HeroUI 3 实际 variant 名对齐） |

## 10. axe-core 检查清单（Playwright + @axe-core/playwright，tags: wcag2a, wcag2aa, wcag21aa, wcag22aa）

对以下每个视图 × 三种 locale 运行，0 violation 方可合入：

- [ ] 任务列表：默认（更新时间降序，`aria-sort` 仅在当前列）、按标题升序、筛选无结果、首次加载中、首批出错
- [ ] 加载更多：加载中（`aria-disabled` + `aria-busy`）、加载更多出错（已加载条目保留 + 行内 Alert）、已全部加载、INVALID_CURSOR 重新加载提示
- [ ] 排序/筛选切换过渡态（ProgressBar 有 `aria-label`）
- [ ] 手测：加载更多后焦点落在新批首行且未被遮挡；读屏播报「已加载 N 条」一次
- [ ] 任务详情：直接深链进入、复制后（toast 存在时）、剪贴板降级 Modal
- [ ] 403 权限不足页、404 找不到或无权访问页
- [ ] 创建任务 Modal：超时 warning、幂等成功 success（mock `Idempotency-Replayed: true`）、普通错误
- [ ] 管理页**四个** Tab（含组织账号）：有数据、空、错误；有限只读成员 Tab（无写按钮 + 只读 Alert）
- [ ] 本项目停用确认（含/不含任务数、LAST_ADMIN）、归档阻塞列表、恢复确认、表单字段错误态
- [ ] 组织账号 Tab（仅组织 ADMIN）：列表、空、错误；`?tab=org-accounts`；账号级停用确认（含「无法登录」警示）；`LAST_ORG_ADMIN` 对话框内错误
- [ ] 仅项目 ADMIN：组织账号 Tab 不在 DOM；`?tab=org-accounts` → 403
- [ ] 「链接失效」页
- [ ] 非管理员访问管理 URL
- [ ] 重点规则：`color-contrast`、`button-name`、`link-name`、`label`、`aria-allowed-role`、`aria-required-children`、`aria-dialog-name`、`region`/`landmark-*`、`page-has-heading-one`、`list`/`listitem`、`target-size`、`nested-interactive`（行可点击 + 行内按钮易触发）、`duplicate-id-aria`
- [ ] axe 不覆盖的手测：键盘全流程、焦点可见与不被遮挡、焦点返回触发点、320px 重排、200% 缩放、text-spacing 书签测试、NVDA/VoiceOver 播报（超时/复制/计数）、`prefers-reduced-motion`
- [ ] ru-RU 截图对比：按钮无截断、无水平滚动

## 11. 评审发现汇总（Must / Should / Nice）

- **Must fix**：控件边框 `--field-border #cbd5e1` 对白底不足 3:1（1.4.11），需确认（O1）。
- **Must fix**：确认对话框不可沿用 `isDismissable` 遮罩关闭；需 `alertdialog` 与焦点管理。
- **Must fix**：超时提示需 live region 且不清空表单。
- **Should fix**：无效 page 段静默回退 overview → 改为链接失效页。
- **Should fix**：管理页 `<Json>` 原样输出改为表格。
- **Should fix**：行可点击 + 行内复制按钮存在嵌套交互风险，实现时用「标题链接 + 独立按钮」而非整行 `<a>`。
- **Nice to have**：帮助页补充筛选、停用说明；批量操作。

## 12. 开放问题

| # | 问题 | 状态 / 结论 | 负责人 |
|---|---|---|---|
| O1 | 控件边框颜色是否改为 `#64748b` 以满足 1.4.11？（与 US-10「视觉零变化」冲突） | 开放；建议随 US-11b 调整 | Weh / jack |
| O2 | 任务列表是否需要跨项目「项目」筛选？ | **已解决**：本期无跨项目视图，隐藏「项目」筛选 | — |
| O3 | 服务端能否返回总数？ | **已解决**：不返回；「加载更多」+「已全部加载」 | — |
| O3a | 排序字段范围 | **已解决**：Weh 确认 Q10——仅 `updated_at`、`title`；前端始终显式传 sort/order，默认更新时间降序 | — |
| O13 | 末批提示用词 | **已解决**：peter 已确认并统一 PRD 为「已全部加载」（PRD v3.1+） | — |
| O4 | 无法识别的链接 | **已解决**：显示「链接失效」页 +「返回项目概览」（§4.3a） | — |
| O5 | OIDC 登录后回跳 | **已解决**：路径已实现；增量保留 search + hash | chatgpt |
| O6 | 403 vs 404 | **已解决**：非成员/不存在→404；成员角色不足→403 | — |
| O7 | 幂等重放标志 | **已解决**：`Idempotency-Replayed: true`（US-13a）；「已成功，无需重复提交」仅以此为准（US-13b） | chatgpt |
| O8 / Q9 / Q9a | 账号级停用谁来做 | **已解决（Weh）**：本期做 US-14b；**仅组织 ADMIN**；须新增组织 ADMIN 角色，与 `registerHuman`（任一项目 ADMIN）不对称；§6.0/6.4 | — |
| O9 | 归档确认 / 恢复 | **已解决**：普通二次确认；RESTORE；阻塞时列清单（§6.5） | — |
| O10 | 停用后任务 | **已解决**：不自动转交；提示 D07；可选未完成计数（假设） | — |
| O11 | Figma 中文字体 | 开放；线框以文档为准 | jack |
| O12 | 项目级停用的会话范围 | **已解决**：只吊销本项目委托的 Agent/MCP 会话；不影响 OIDC 登录与其他项目 | — |

## 13. 实现对接点（原 C1–C6，**v3.4 全部已关闭**）

| # | 结论（写入规范，供实现） | 状态 |
|---|---|---|
| **C1** | `GET /me` 增加 **`is_org_admin: boolean`**；种子/bootstrap 授予；本期不做授予/撤销 UI | **已解决** |
| **C2** | Weh 确认：**有限只读**——组织 ADMIN 且为本项目成员但非项目 ADMIN → 可看成员表、不可改；统一见 §6.1 | **已解决** |
| **C3** | 组织 ADMIN **可以**创建项目，且保留「任一项目 ADMIN 可创建」。**须扩展** createProject / `executeOrganization` 鉴权为「组织 ADMIN **或** 任一项目 ADMIN」 | **已解决**（后端工作） |
| **C4** | 项目成员 API/UI 拆分 **`membership_active`** 与 **`account_active`**；账号停用显示独立 Chip「账号已停用」，并隐藏「从本项目停用」 | **已解决** |
| **C5** | M5 MVP：`/projects/:pid/management?tab=org-accounts`；独立 `/organization/accounts` 为后续可选 | **已解决** |
| **C6** | 扩展 `GET /organization/members`；账号级停用写接口 **仅组织 ADMIN**（禁止复用「任一项目 ADMIN」）；409 **`LAST_ORG_ADMIN`** UI 见 §6.4.4 | **已解决** |

### 13.0 审核 must-fix 落地对照（ui-audit-next-phase.md）

| ID | 要求 | v3.4 |
|---|---|---|
| M1 | §6.1 与 C2 统一有限只读 | ✔ §6.1 |
| M2 | `/me` 暴露组织 ADMIN 标志 | ✔ `is_org_admin` §6.0 / C1 |
| M3 | 勿合成单一 active | ✔ `membership_active` + `account_active` §6.2 / C4 |
| M4 | 账号停用勿用「任一项目 ADMIN」鉴权 | ✔ §6.0 硬约束 / C6 |
| M5 | 组织 ADMIN 建项目须扩 createProject 鉴权 | ✔ §6.1 / C3 |
| M6 | 路由可落地 | ✔ Tab + `?tab=org-accounts` / C5 |
| M7 | `LAST_ORG_ADMIN` UI | ✔ §6.4.4 / §6.8 |

### 13.1 与 PRD v5 核对摘要（US-11b / 12 / 13b）

| 故事 | 规范状态 |
|---|---|
| US-11b | §3 已对齐：排序两字段×升降序、始终选中、默认更新时间降序、显式 sort/order 进 URL、「加载更多」/「已全部加载」、无总数页码；O13 已关闭 |
| US-12 | §4 已对齐：复制链接；404「找不到或无权访问」；「链接失效」+ 返回概览；403 权限不足；returnTo 保留 query/hash |
| US-13b | §5 已对齐：超时重试；仅 `Idempotency-Replayed: true` 显示「已成功，无需重复提交」 |
| US-14 / 14b | §6 已对齐 v3.4：有限只读、双 active、Tab 路由、LAST_ORG_ADMIN、鉴权不对称 |

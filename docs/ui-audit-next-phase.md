# ACCP 下一阶段 UI 规范审核报告

- 审核人：chatgpt（Codex 桥接 bot，只读审核）
- 日期：2026-10-25（America/Chicago）
- 审核对象：初审 `ui-spec` **v3.3**；复审对象 **v3.4**（见 §11，Verdict **Pass**）
- 对照：`docs/product-plan-next-phase.md` 草案 **v5**、`docs/requirements-next-step.md` **v3**
- Figma：<https://www.figma.com/design/k3OpUtH1QpUfO8gQrq5qQY（已读元数据；6> 个画框）
- 代码现状（只读）：共享机 `/workspace/projects/accp`（`internal/controlplane/{management,identity,sessions}.go`，`web/src/{management,routing,main}.tsx`，`contracts/openapi.yaml`）
- 约束：不改业务代码；不 commit / push；本文件为审核交付物

---

## 1. Verdict

### **Conditional pass（有条件通过）**

设计在 **US-14 vs US-14b 文案分区、入口隔离、Q9a「仅组织 ADMIN」** 上与 PRD v5 / requirements v3 **一致且可交付给实现**；无障碍与防混淆原则到位。

但存在若干 **实现前必须闭合** 的缺口（API/鉴权/`/me` 字段、成员列表 active 语义、路由、§6.1 与 C2 自相矛盾）。闭合前不宜按规范直接开工 US-14b 前端。

**不是 Fail**：未发现与 Weh 已拍板决策（Q9/Q9a）相冲突的产品方向错误。

---

## 2. 审核范围与版本

| 项 | 版本 / 说明 |
|---|---|
| UI 规范 | v3.3｜2026-10-25｜jack |
| PRD | 草案 v5（Q9a=仅组织 ADMIN，与 registerHuman 不对称） |
| Requirements | v3（关闭 Q9a） |
| Figma | 文件 `k3OpUtH1QpUfO8gQrq5qQY`：画框 1–5 + **「6 组织账号 US-14b」**（`8:2`） |
| 代码 | 共享 checkout；未改文件 |

重点：US-14 / US-14b、§6.0 组织 ADMIN、C1–C6、与 `registerHuman` / 项目级停用现网语义冲突。

---

## 3. Findings 总表

### 3.1 Must fix（阻塞实现或会导致错误产品行为）

| ID | 发现 | 说明 |
|---|---|---|
| **M1** | **§6.1「成员」Tab 可见条件与 C2 默认矛盾** | §6.1 写「项目 ADMIN **或** 组织 ADMIN（在本项目有 ADMIN）」；C2 默认是「组织 ADMIN 但非项目 ADMIN → **只读列表**」。二者互斥表述。须统一为一句可实现规则（见 §5 C2）。 |
| **M2** | **`/me` 无组织 ADMIN 标志（C1）** | 现网 `me()` 仅返回 `id, organization_id, display_name, kind`（`identity.go:9-12`）；schema 亦无 `org_roles` / `is_org_admin`。UI 无法按规范隐藏「组织账号」入口。US-14b 开工前须落合同字段。 |
| **M3** | **项目成员列表 `active` 合并账号态（C4）** | `members` SQL：`m.active AND u.active` 合成单一 `active`（`identity.go:42`）。规范要求同时展示「已停用」（membership）与 Chip「账号已停用」。**现 API 无法区分**。须拆字段（建议 `membership_active` + `account_active`，或保留 `active`=membership 并加 `user_active`/`account_active`）。 |
| **M4** | **账号级停用写路径与鉴权不存在（C6）** | 无 `human_users.active=false` 写路径；`changeMember` 只改 `memberships`。组织级写入口 `executeOrganization` 鉴权是「**任一项目 ADMIN**」（`management.go:39-41`）——与 Q9a **故意不对称**。须新增 org-ADMIN-only 停用 API，且 **禁止** 复用现有「任一项目 ADMIN」门槛。 |
| **M5** | **C3 与现网 createProject 鉴权缺口** | 规范默认「组织 ADMIN 可创建项目」。现网 `POST /projects` 走 `executeOrganization`，要求调用方已是**某项目** ADMIN。纯组织 ADMIN（零项目 ADMIN）今日会 403。若采纳 C3 默认，后端须改为「组织 ADMIN **或** 任一项目 ADMIN」。 |
| **M6** | **C5 路由与 SPA 现实冲突** | `routing.ts` **仅**支持 `/projects/:projectID/:page`；未知前缀落到空 project。规范建议 `/organization/accounts` 需改路由/OIDC returnTo。实现前必须选定一种可落地方案（见 C5 建议），否则深链与 US-12 returnTo 会静默失效。 |
| **M7** | **最后一名组织 ADMIN / 自锁死** | UI 已隐藏「自己」行（好）。C6 提到可能的 `LAST_ORG_ADMIN`，但 §6.8 未给文案/对话框行为。若后端加 409，UI **必须**有对等处理（对齐 `LAST_ADMIN`）。建议：**Must** 在规范补一行错误态；产品上 **应** 禁止停用最后一名组织 ADMIN。 |

### 3.2 Should fix（强烈建议，不阻塞「方向正确」结论）

| ID | 发现 | 说明 |
|---|---|---|
| **S1** | §0 权限现状表未反映组织 ADMIN | 仍写 `administrator = 任一项目含 ADMIN`。应加注「v3.3 起组织 ADMIN 为独立标志，管理入口矩阵见 §6.0」。 |
| **S2** | axe 清单仍写「管理页三个 Tab」 | §10 应改为含「组织账号」的四 Tab，并保留「仅项目 ADMIN 不可见 + 直链 403」用例（后半已有）。 |
| **S3** | 组织账号列表 API 命名 | C6 建议 `GET /organization/users`；现网已有 `GET /organization/members`（返回 Human+`active`）。优先扩展鉴权/字段，避免双列表语义漂移。 |
| **S4** | O1 控件边框对比度 | 规范已标 Must（1.4.11），与 US-10「视觉零变化」冲突仍开放。实现 US-11b/管理页时二选一：改 token 或接受已知 a11y 债并记入验收例外。 |
| **S5** | 「添加成员」与 registerHuman 流程 | 现管理页是「注册组织成员 + 再加入项目」两步；规范线框偏「单 Modal」。实现时保持审计 `reason` 与幂等，勿把账号级停用权限误绑到 registerHuman。 |
| **S6** | 帮助文档（Nielsen 10） | §6.10 已标 Should：帮助页对比两种停用。M5 可并行短文案。 |

### 3.3 Nice to have

| ID | 发现 |
|---|---|
| **N1** | 账号级停用成功后，已打开的项目成员页「下次刷新才显示 Chip」——可加轻量 invalidate/焦点回页提示。 |
| **N2** | Figma 中文缺字（O11）——继续以文档文案为准即可。 |
| **N3** | 顶栏同时具备组织 ADMIN + 项目 ADMIN 时 Chip 并存规则（并排 / 优先显示组织）可再写一句，避免实现各异。 |

---

## 4. US-14 vs US-14b / 组织 ADMIN 分析

### 4.1 与 PRD / 拍板一致性

| 检查点 | 结论 |
|---|---|
| US-14 项目级：不写「无法登录」、只吊销本项目委托会话、任务不自动转交 | **通过** — §6.3 确认文案与 PRD UI 第 4 项对齐；禁止语明确 |
| US-14b 账号级：可写「无法登录」；仅组织 ADMIN | **通过** — §6.4.3 / §6.8；入口隐藏 + 直链 403 |
| 与 `registerHuman`（任一项目 ADMIN）不对称 | **设计正确** — §6.0 明文；实现须保证 **停用账号** 鉴权 ≠ `executeOrganization` 现门槛 |
| 防混淆（按钮文案、对话框、danger vs danger-soft、独立入口） | **通过** — Must 原则 1–4 清晰；Figma 画框 4 + 6 一致 |
| Q9a 关闭后无开放产品拍板 | **通过** — 剩余为 C1–C6 **实现/合同** 开放点，非「要不要做」 |

### 4.2 §6.0 可实现性

- **概念可实现**：组织级标志与项目 `roles` 分离，前端隐藏优于禁用，符合现网管理模式。
- **缺口**：标志来源（M2）、写路径鉴权（M4）、纯组织 ADMIN 的项目创建（M5）、无项目前缀路由（M6）。
- **冲突风险**：若错误地把账号停用挂到现有 `organization: true` 路由且不改 `executeOrganization`，会变成「任一项目 ADMIN 可全局锁人」——正是 PRD 风险表要防的。**规范已警告；实现 checklist 须有集成测试「仅项目 ADMIN → 403」。**

### 4.3 与现网停用 / registerHuman 语义

| 能力 | 现网 | 规范期望 | 冲突？ |
|---|---|---|---|
| 项目停用 | `POST .../members/{user}/changes`，`memberships.active`；`revokeManagedSessions`；`LAST_ADMIN` | 同左 + UI | 无；UI 补齐即可 |
| 读 `human_users.active` | sessions 登录路径已读；**无写路径** | US-14b 写 false | 需新 API |
| registerHuman | 任一项目 ADMIN；创建 Human，**不**推断 membership | 保持不对称；不做账号停用 | 无冲突，须保持 |
| `GET /organization/members` | 任一项目 ADMIN 可列出组织人类（含 `active`） | 组织账号页仅组织 ADMIN 操作停用 | 列表可对项目 ADMIN 保留（注册选人）；**停用**必须收紧。UI 不得因列表 API 对项目 ADMIN 可见就露出「停用账号」 |

---

## 5. C1–C6 建议

| # | 建议默认 | 是否必须 Weh 再拍 | 备注 |
|---|---|---|---|
| **C1** | **`GET /me` 增加 `is_org_admin: boolean`（MVP）**；种子/bootstrap 授予首个组织 ADMIN；本期不做授予 UI | **否**（存储形态 requirements 已允「实现时再定」）。若 Weh 强烈偏好数组 `org_roles`，可等价，但前端 MVP 用布尔即可 | Must 在 US-14b 后端 PR 合入合同；UI 不猜测 |
| **C2** | **修正规范措辞后采用「有限只读」**：① 当前项目 **具有项目 ADMIN** → 可写成员；② 组织 ADMIN 且为本项目成员但非 ADMIN → **只读**成员表、隐藏添加/停用；③ 组织 ADMIN **不是**本项目成员 → **不展示**本项目成员写入口；组织账号 Tab 仍可用 | **建议 Weh 确认一次「③ 是否允许不在项目内的组织 ADMIN 打开任意项目上下文」**（安全/隐私）。若不想拍板，实现选：组织账号用脱离项目的壳页面（见 C5），避免「巡视他项目成员」 | 同时 **Must** 改掉 §6.1 与 C2 矛盾句 |
| **C3** | **采纳设计默认**：组织 ADMIN **可以**创建项目；任一项目 ADMIN **仍可**创建（现状） | **否**（与「组织 ADMIN 管组织」一致）。后端改鉴权即可 | 记入 M5；测「零项目 ADMIN 的组织 ADMIN 可 POST /projects」 |
| **C4** | **API 拆字段**；UI：`account_active=false` → Chip「账号已停用」+ 隐藏「从本项目停用」；membership 停用仍用「已停用」 | **否** | Must；无拆字段则删掉「账号已停用」Chip 需求（不推荐） |
| **C5** | **推荐 M5 MVP**：保留 `/projects/:pid/management`，用 Tab/`?tab=org-accounts` 承载组织账号（侧栏文案仍叫「组织账号」）；文档注明「非挂在成员行上」。**后续**再加真正的 `/organization/accounts` 并扩展 `routing.ts` + returnTo | **若要坚持独立 pathname，则须 Weh/实现拍板排期路由改造**；否则用 Tab MVP 即可不开产品会 | 独立 URL 与防混淆更优，但成本高于 Tab |
| **C6** | **写**：`POST /api/v1/organization/members/{user}/changes`（body: `active:false` + `reason`，Idempotency-Key）或显式 `.../deactivate`；鉴权 **仅组织 ADMIN**。**读**：复用/扩展 `GET /organization/members`（返回 `active`=账号态；可加 `org_roles`）。**409 `LAST_ORG_ADMIN`**：建议要，UI 对齐 LAST_ADMIN | **`LAST_ORG_ADMIN` 建议 Weh 默认「要」**（防锁死组织）；路径风格可实现自定 | 勿让项目 ADMIN 调用成功 |

---

## 6. API / 路由 / 错误码缺口

### 6.1 缺口清单

| 缺口 | 优先级 |
|---|---|
| `is_org_admin`（或 `org_roles`）于 `/me` | Must |
| 账号级停用写 API + org-ADMIN-only 鉴权 + 审计 + 吊销**全部**委托会话 | Must |
| 项目成员列表拆分 account vs membership active | Must |
| （可选但强烈）`LAST_ORG_ADMIN` 409 + 文案 | Must（若做防锁死） |
| 组织 ADMIN 创建项目鉴权扩展 | Must（若 C3 默认） |
| SPA 支持组织账号深链（Tab 或新 path） | Must（C5） |
| OpenAPI / management schema 同步 | Must（合入同 PR） |

### 6.2 错误码（UI 已覆盖 / 待补）

| 码 | US | UI 规范 |
|---|---|---|
| `LAST_ADMIN` | US-14 | 已有 §6.3a / §6.8 |
| `403` 非组织 ADMIN 账号停用 | US-14b | 已有对话框内文案 + 直链页 |
| `LAST_ORG_ADMIN`（建议） | US-14b | **待补** |
| `IDEMPOTENCY_*` | 写操作 | 走 §5 |
| 不能停用自己 | 两端 | UI 隐藏；后端仍应 403/422 兜底 |

### 6.3 路由

- 现状：仅 `/projects/:id/{page}`。
- 规范候选：`/organization/accounts`。
- 风险：直接采用会导致 `readRoute` 丢上下文 → 误进「链接失效」或 overview。
- 建议：见 C5。

---

## 7. Figma 对齐说明

已用 Figma MCP `get_metadata`（fileKey `k3OpUtH1QpUfO8gQrq5qQY`，Page `0:1`）。

| 画框 | node | 与 ui-spec |
|---|---|---|
| 1 任务列表 US-11b | `1:2` | 对齐 §3（加载更多、排序、无项目筛选） |
| 2 深链接 US-12 | `1:17` | 对齐 §4（403/404/链接失效） |
| 3 写操作超时 US-13 | `1:30` | 对齐 §5（含 Idempotency-Replayed） |
| 4 日常管理 US-14/14b/15 | `1:41` | Tabs 含「组织账号(仅组织ADMIN)」；项目级确认禁止「无法登录」— 对齐 §6 |
| 5 GitHub US-5 | `1:54` | 对齐 §7 |
| **6 组织账号 US-14b** | `8:2` | 独立画框：停用账号 danger、无法登录文案、空态、顶栏 Chip、本期不做授予/恢复 — **与 §6.4 一致** |

线框为灰阶注释型；中文缺字时以文档 §6.8 为准（O11）。**未发现 Figma 与 v3.3 文档在停用分区上的冲突。**

---

## 8. 无障碍 / 可用性快评（相对 design-review checklist）

| 项 | 评价 |
|---|---|
| 状态不只靠颜色 | 好（Chip 文案、账号级警示图标） |
| alertdialog / 焦点 / 原因必填 | 好（Must 已写） |
| 目标尺寸 / ru 余量 / 不定宽按钮 | 好 |
| 1.4.11 控件边框 O1 | 仍开放（S4） |
| 权限隐藏 vs 禁用 | 好；与读屏「不把组织账号 Tab 留在 DOM」一致 |
| 两套停用防错 | 强（文案+入口+视觉层级） |

---

## 9. 建议的规范修订清单（给 jack，非本任务执行）

1. 统一 §6.1 与 C2 的「组织 ADMIN × 本项目成员 Tab」规则（M1）。
2. §6.8 / §6.4 增加 `LAST_ORG_ADMIN` 对话框行为（M7）。
3. §0 现状表补组织 ADMIN；§10 axe「三 Tab」→「四 Tab」（S1/S2）。
4. C5 写明「M5 采用 management Tab MVP」或「阻塞等待路由改造」二选一，去掉模糊双路径。
5. C6 改为「优先扩展 `/organization/members` + 新 changes/deactivate」，避免平行 `users` 资源除非有强理由。

---

## 10. 结论摘要（可转 Weh）

**Verdict: Conditional pass。**

US-14 / US-14b 文案与权限分区、Figma 画框 6、与 Q9a 对齐均合格。实现前须闭合：`/me` 组织管理员标志、账号停用专用鉴权 API、成员列表 account/membership active 拆分、路由方案、§6.1↔C2 措辞，并建议补 `LAST_ORG_ADMIN`。C1–C6 建议默认见本文 §5；仅 C2③（跨项目巡视）与「是否坚持独立 `/organization/accounts` URL」建议 Weh 一眼确认，其余可由实现按默认推进。

---

## 11. Re-review（复审）｜2026-10-25 America/Chicago

- 审核人：chatgpt（只读）
- 审核对象：`docs/ui-spec-next-phase.md` **v3.4**（jack；声称闭合初审 must-fix + Weh 确认 C2）
- 对照：本文件 §1–§10（初审 v3.3）、PRD 草案 v5、requirements v3
- Figma：画框 `8:2`「6 组织账号 US-14b (v3.4)」已更新为 Tab/`?tab=org-accounts`、`LAST_ORG_ADMIN`、`is_org_admin`（与文档一致）
- 代码：仅只读复核实现可行性；**未改业务代码、未 commit/push**

### 11.1 Re-review Verdict

### **Pass（通过）**

初审 **M1–M7 均已在规范正文闭合**；C1–C6 结论写入 §13 且内部一致；与 PRD v5 / Q9a 无新冲突。剩余工作属于 **M5 后端/合同实现**（规范已标明），不再构成 UI 规范层面的 must-fix。

O1（控件边框对比度）仍开放——属既有 a11y 债，**非**本次 US-14/14b must-fix 回潮。

### 11.2 初审 Must-fix 闭合核对

| ID | 初审要求 | v3.4 落地 | 复审 |
|---|---|---|---|
| **M1** | §6.1 与 C2 统一 | §6.1「有限只读」表 + Weh 确认句；可见条件与写能力拆开 | **已关闭** |
| **M2** | `/me` 组织 ADMIN 标志 | §6.0 / C1：`is_org_admin: boolean`；禁止用「任一项目 ADMIN」推断 | **已关闭**（规范侧；代码仍待实现） |
| **M3** | 勿合成单一 `active` | §6.2：`membership_active` + `account_active`；线框分列 | **已关闭**（规范侧） |
| **M4** | 账号停用勿复用任一项目 ADMIN | §6.0 鉴权硬约束 + C6 + 集成测试要求 | **已关闭**（规范侧） |
| **M5** | 组织 ADMIN 建项目须扩鉴权 | §6.1 / C3 明文扩展 `executeOrganization` / createProject | **已关闭**（规范侧） |
| **M6** | 路由可落地 | C5：`/projects/:pid/management?tab=org-accounts` MVP；独立 URL 标后续 | **已关闭** |
| **M7** | `LAST_ORG_ADMIN` UI | §6.4.4 行为对齐 LAST_ADMIN；§6.8 三语文案 | **已关闭** |

初审 Should：**S1**（§0 权限表）、**S2**（axe 四 Tab）、**S3**（扩展 `/organization/members` 而非平行 users）、**N3**（Chip 并排组织在左）均已吸收。**S4/O1、S5、S6** 仍为实现期建议，不挡 Pass。

### 11.3 新问题 / 回归

| 级别 | 发现 | 处理建议 |
|---|---|---|
| **无 Must** | — | — |
| **Should** | `LAST_ORG_ADMIN` 文案写「请先将组织管理员授予他人」，但本期 **无** 授予 UI（C1）。用户可能误以为控制台可授予。 | 实现时错误说明可加一句「由运维/种子配置授予」；或帮助页指向运维流程。不要求再改产品拍板。 |
| **Should** | 组织账号挂在 `/projects/:pid/management`：若组织 ADMIN **零项目成员资格**，现网无法进入任一 management 壳，也就打不开「组织账号」Tab（与「可通过其他已加入项目打开」前提相关）。 | Bootstrap/种子保证组织 ADMIN ≥1 个项目成员；或后续独立 URL。属实现约束，非规范自相矛盾。 |
| **Nice** | §6.1 归档「组织 ADMIN 否则只读【假设同 C2】」略简；与成员 Tab 细则相比偏短。 | 实现按「非项目 ADMIN 则隐藏归档/恢复写按钮」即可。 |
| **Nice** | Figma 文件头仍写「5 个画框」而实际 6 个；以画框 `8:2` 与文档为准。 | jack 可顺手改文件说明。 |

未发现 US-14 / US-14b 文案分区回潮或重新把账号停用绑到「任一项目 ADMIN」的表述。

### 11.4 C1–C6 相对现网代码的可实现性（只读快检）

| # | 规范结论 | 现网（共享 checkout） | 可实现？ |
|---|---|---|---|
| **C1** | `me.is_org_admin` | `me()` 仅 `id/organization_id/display_name/kind`；Human schema 无该字段；库无组织角色表 | **是** — 需迁移/bootstrap + `/me` + OpenAPI；UI 消费布尔即可 |
| **C2** | 有限只读 | 前端 `administrator = 任一项目 ADMIN`；无 org 标志 | **是** — 前端按 `is_org_admin` + 当前项目 `roles` 分支；无新路由 |
| **C3** | 组织 ADMIN 可建项目 | `POST /projects` → `executeOrganization` 要求某项目 ADMIN | **是** — 扩展鉴权为 org ADMIN **或** 项目 ADMIN；测纯 org ADMIN |
| **C4** | 双 active 字段 | `members` SQL：`m.active AND u.active` → 单一 `active` | **是** — 改 SELECT/JSON；注意兼容或版本化合同 |
| **C5** | `management?tab=org-accounts` | `routing.ts` 已有 `management` page；query 未用 | **是** — 读 `URLSearchParams`；**不必**改 pathname。OIDC returnTo 若只存 pathname，须确认是否保留 search（US-12 增量） |
| **C6** | org-ADMIN-only 停用 + 扩展 list + `LAST_ORG_ADMIN` | 无账号停用写路径；`organizationMembers` 已返回 `active`；鉴权为项目 ADMIN | **是** — **新写路径不得**走现有「任一项目 ADMIN」门槛；list 可复用并加 org 角色展示字段；加 409 码 |

**实现顺序建议（供 M5，非本审核范围）：** C1 存储 + `/me` → C6 写路径/鉴权/测试 → C4 列表字段 → C3 鉴权扩展 → 前端 Tabs/C2/C5。

### 11.5 结论（可转 Weh）

**复审 Pass。** 初审 must-fix 1–7 全部在 v3.4 闭合；C1–C6 已关闭且与代码路径可对接。无新的规范级 Must。剩余为后端落地与两则 Should（LAST_ORG_ADMIN 文案 vs 无授予 UI；零项目成员的组织 ADMIN 壳页面）。O1 仍开放，与本次无关。

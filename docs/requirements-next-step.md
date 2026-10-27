# ACCP「下一步」需求分析

- 版本：**v3.1**｜日期：2026-10-27（America/Chicago）｜作者：peter｜类型：下一步需求分析（排期消化）
- 相对 v3：同步 **M5 已完成**（US-14 / US-14b / US-15；`19e3428` / `d69cc2d` / `f5e63a8`）；相对 v2：关闭 **Q9a**——账号级停用仅「组织 ADMIN」；须新增该角色，与 registerHuman 不对称
- 输入：
  - [next-phase-plan.md](next-phase-plan.md)
  - [product-plan-next-phase.md](product-plan-next-phase.md)（草案 **v5.1**，与本文同步；M5 已完成）
  - [ui-audit-next-phase.md](ui-audit-next-phase.md)
  - [ui-spec-next-phase.md](ui-spec-next-phase.md)
- 约定：**【事实】** 有出处；**【假设】** 未最终确认；**【Weh 已确认】** 2026-10-25 拍板。只写文档，不改代码、不 commit/push、**不调 GitHub API 创建 milestone/issue**。

---

## 1. 背景与输入

### 1.1 审计结论【事实】

初审 **Conditional pass**（4 条 must-fix）；复审 **Pass**（must-fix 已落入故事；O3a/O12 文案已修）。详见 ui-audit-next-phase.md。

### 1.2 PRD 修订状态【事实】

| 版本 | 要点 |
|---|---|
| v1–v3.1 | must-fix + O3a/O12/O13 |
| **v4（2026-10-25）** | Weh 拍板 Q1–Q10；Q5 全自动；Q9→US-14b 入阶段 B；§15 改为已确认表 |
| **v5（2026-10-25）** | **关闭 Q9a**：仅组织 ADMIN 可账号级停用；须新增组织 ADMIN 角色，与 registerHuman 不对称 |

### 1.3 与 next-phase-plan

技术 P0/P1 不变；产品侧已关闭原开放假设，进入可建 issue / 可排期状态（API 创建仍禁止，仅文档列清单）。

---

## 2. Weh 已确认（2026-10-25）

> 醒目关闭原 §待拍板清单。权威表亦见 PRD §15.1。

| # | 决定 | 落地影响 |
|---|---|---|
| **Q1** | **采纳 A1**：单机；约 50 人 + 200 Agent 会话；SLO：读 P95 < 300ms、写 < 800ms、事件可见 P95 < 2s、5xx < 0.1% | US-1 可按此写 W0；US-2/16 靶子冻结 |
| **Q2** | **采纳 A2**：专用小私有测试仓 + 只读 fine-grained token | 仅 US-5 仍等 token 实物；方案不阻塞 |
| **Q3** | **建 GitHub milestone**；建议按故事建 issue 挂 M1–M5，**已确认可建** | 见本文 **§8 拟建清单**（**禁止调 API**） |
| **Q4** | **先 US-10，再 D08 / US-11–13** | M4 顺序锁定 |
| **Q5** | **改默认→全自动**：tag → CI → GHCR + **正式 Release 自动发布**（非草稿+人工） | US-7/8/9、M2、风险已改；升级说明=CI 门禁 |
| **Q6** | **接受** PRD 推断性 OKR | §4 不再「待确认」 |
| **Q7** | **单人等效**估期；真实投入后再改日期 | 里程碑日期仍为【假设】日历 |
| **Q8** | **本期不做**目标 IdP 身份演练 | 仅 US-17 文档统一 |
| **Q9** | **要做全账号停用**：US-14b **升入阶段 B**（建议 M5，紧随 US-14）；UI 可写「停用后无法登录」 | 非目标删除「本期不做」；UI 第 7 项改为需 jack |
| **Q9a** | 授权选 **B：只有「组织 ADMIN」能做** | 须**新增组织 ADMIN 角色/权限**；**与 `registerHuman`（任一项目 ADMIN）明确不对称**；仅项目 ADMIN → 403 |
| **Q10** | 排序字段 **仅** `updated_at`、`title` | US-11a 接口范围锁定 |

### 仍开放子项

无。Q1–Q10 与 Q9a 均已关闭。

---

## 3. 审计 must-fix 消化表（更新状态）

| # | must-fix / 补充 | 故事 | 估算 | 状态 |
|---|---|---|---|---|
| MF1 | 复合游标 + 无总条数 | US-11a / 11b | 5 + 4 | 已写入；**Q10 已确认** |
| MF2 | 停用范围 | US-14 项目级；**US-14b 账号级→阶段 B，仅组织 ADMIN** | 4 + 5 | **M5 已完成 2026-10-27**（`19e3428` / `d69cc2d`；Q9+Q9a；组织 ADMIN 授予/撤销与账号恢复仍延期） |
| MF3 | 重放信号 | US-13a / 13b | 1.5 + 2 | 可开工；13a=首 PR |
| MF4 | O5 勿重做深链 | US-12 增量 | 1.5 | 已写入 |
| O3a / O12 / O13 | 文案 | — | — | 已写入 PRD |

**结论：must-fix 全部可排期；Q1–Q10 与 Q9a 全部关闭，无开放拍板子项。**

---

## 4. 阶段 A（RC）vs 阶段 B

### 4.1 阶段 A — RC 必需（M0–M3）

| 故事 | 验收摘要 | 依赖 | 里程碑 |
|---|---|---|---|
| US-1 W0 | 带日期 W0 文档（数字=A1） | Q1 已确认 | M0 |
| US-13a | `Idempotency-Replayed: true` | 无 | **M1 首 PR** |
| US-4 | race+integration 全绿 | 容器 | M1 |
| US-6 | grants 升级检查 | 无 | M1 |
| US-5 | 真实 token 同步 | **A2 实物 token** | M1（可后插） |
| US-7 | tag→CI→GHCR digest + Bridge + 校验和 + **正式 Release** | A5 全自动 | M2 |
| US-8 | 升级说明 **CI 门禁**；未过不发版 | 与 US-7 同流水线 | M2 |
| US-9 | 干净安装/升级冒烟 | US-7、US-8 | M2 → rc.1 |
| US-2 / US-3? | 压测；必要时连接池可配 | US-1 | M3 |
| US-16 | 恢复演练 | US-1 | M3 |

**RC 放行【事实，PRD §11】**：M1–M3 完成且压测达标，或 Weh 书面接受差距。

### 4.2 阶段 B — 可持续使用（M4–M5）

| 故事 | 摘要 | 依赖 | 里程碑 |
|---|---|---|---|
| US-10 | 前端拆分，视觉零变化 | **先于 D08（Q4）** | M4 |
| US-11a / 11b | 排序+复合游标；加载更多 / 已全部加载 | 11b→10+11a；字段=Q10 | M4 |
| US-12 | returnTo query+hash；复制链接；失效页 | 部分→11b | M4 |
| US-13b | 超时重试 UI | 13a | M4 |
| US-17 | audience 文档一致 | 无；**无 IdP 演练（Q8）** | M4 |
| US-14 | 项目级成员管理 | 后端已有 | **M5 已完成**（`19e3428`） |
| **US-14b** | **账号级停用（仅组织 ADMIN；须新增该角色）** | 无开放拍板 | **M5 已完成**（`d69cc2d`；授予/撤销与账号恢复仍延期） |
| US-15 | 项目归档/恢复、仓库 | 后端已有 | **M5 已完成**（`f5e63a8`） |

### 4.3 阶段 C / 仍范围外

P2-1…P2-4。~~US-14b~~ 已不在此列。目标 IdP 演练本期不做（Q8）。

---

## 5. 事实 vs 假设

### 事实（摘）

- 审计 / 代码现状（列表无总数、随机 id、项目级停用、无重放头、深链仅 pathname）见 PRD §2.1。
- **Weh 已确认 Q1–Q10 与 Q9a**，见 §2。

### 【假设】仍有效

| ID | 内容 |
|---|---|
| 日历 | M0–M5 目标日期按单人等效自 2026-10-26 推算，真实投入后重排（Q7） |
| 压测时长 | ≥30 分钟；前端单文件 ≤400 行 |
| fixture 仓名 | 例如 `JavaWeh/accp-sync-fixture`（名称待定） |
| 组织 ADMIN 存储形态 | 角色如何落库/bootstrap（字段或表）实现时再定；产品要求仅为「存在可授予的组织 ADMIN，且仅其可做 US-14b」 |

---

## 6. 建议下一步动作（不实现、不调 API）

1. ~~**落盘 US-1 W0 文档**（数字已确认=A1）→ 关闭 M0 剩余项。~~ **已完成**：见 [w0-baseline-2026-10-25.md](w0-baseline-2026-10-25.md)。
2. **按 §8 清单**（人工或他员）创建 GitHub milestone/issue——**本文与 PRD 不调用 API**。
3. **首 PR：US-13a**（重放响应头 + 集成测试）。（若已在 main，跳过。）
4. 并行 M1：US-4、US-6；token 到位后 US-5；同时设计 **全自动** 发布 workflow（US-7）与升级说明 CI 门禁（US-8）。
5. ~~M4 前 jack 交付 US-11b/12/13b；**M5 前增加 US-14b**（仅组织 ADMIN 可见；可写「停用后无法登录」；含新增组织 ADMIN 角色的最小可用）。~~ **M5 已完成 2026-10-27**（US-14 / US-14b / US-15；`19e3428`..`f5e63a8`）。仍开放：US-5、Stage C、登录刷新保持、组织 ADMIN 授予/撤销与账号恢复、chatgpt 非阻塞建议（未编码）。

---

## 7. UI 需求摘要

| jack？ | 故事 | 备注 |
|---|---|---|
| 是 | US-11b / 12 / 13b | 同 PRD §14 第 1–3 项 |
| 是 | US-14 / 15 | 项目级；文案勿写「无法登录」 |
| **是（新增本期）** | **US-14b** | 仅**组织 ADMIN**；**可写「停用后无法登录」**；与 US-14 / registerHuman 权限模型不对称 |
| 无 | W0、压测、US-4/6/7/8、US-10、US-11a、US-13a、US-17 | |

---

## 8. 拟建 GitHub milestone / issue 清单

> **【Weh 已确认 Q3】可建。本文仅列清单，禁止调 GitHub API / `gh` 创建。**

### Milestones（建议）

| Milestone | 标题建议 | 目标日期【假设】 | 包含故事 |
|---|---|---|---|
| M0 | ACCP next：决策与 W0 | 2026-10-30 | US-1 |
| M1 | ACCP next：验证欠账 + 首 PR | 2026-11-06 | US-13a, US-4, US-6, US-5 |
| M2 | ACCP next：RC 发布（全自动） | 2026-11-20 | US-7, US-8, US-9 |
| M3 | ACCP next：容量与恢复 | 2026-12-04 | US-2, US-3(条件), US-16 |
| M4 | ACCP next：控制台可持续 | 2026-12-23 | US-10, US-11a, US-11b, US-12, US-13b, US-17 |
| M5 | ACCP next：日常管理（含账号级停用） | 2027-01-13 | US-14, **US-14b**, US-15（**已完成 2026-10-27**） |

### Issues（建议一故事一 issue）

| Issue 标题建议 | Milestone | 备注 |
|---|---|---|
| US-1 Freeze W0 scale/SLO/env matrix | M0 | 正文贴 A1 数字 |
| US-13a Idempotency-Replayed response header | M1 | **第一个 PR**；仅后端 |
| US-4 Complete race+integration test run | M1 | |
| US-6 Upgrade grants check (accp-ops) | M1 | |
| US-5 GitHub sync with real token | M1 | 阻塞：token+fixture 仓 |
| US-7 Fully-automated release to GHCR + GitHub Release | M2 | **全自动**，非草稿 |
| US-8 Upgrade notes as CI gate | M2 | 门禁失败则不发版 |
| US-9 Clean-install and upgrade smoke of RC | M2 | |
| US-2 Load test under W0 | M3 | |
| US-3 Configurable DB pool (if needed) | M3 | 仅压测证明必要时 |
| US-16 Backup/restore drill at W0 scale | M3 | |
| US-10 Split workspace/main/tasks front-end | M4 | 先于 D08 |
| US-11a Task list sort + composite cursor | M4 | 仅 updated_at/title |
| US-11b Task list filter + load more UI | M4 | 「已全部加载」 |
| US-12 Deep-link returnTo query+hash + copy link | M4 | 勿重做整条 OIDC |
| US-13b Write-timeout retry UI | M4 | 依赖 13a |
| US-17 Unify SPA client ID / API audience docs | M4 | 无 IdP 演练 |
| US-14 Project-level member add/deactivate | M5 | **已完成** `19e3428` |
| **US-14b Account-level deactivate (org ADMIN only; new role)** | **M5** | **已完成** `d69cc2d`；Q9+Q9a；授予/撤销与账号恢复仍延期 |
| US-15 Project archive/restore + repo register | M5 | **已完成** `f5e63a8` |

P2 项可不建 milestone，或建 `ACCP next: P2 backlog`（可选，非必须）。

---

## 9. 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-10-25 | 初稿：消化审计 must-fix，阶段 A/B，待拍板清单 |
| v2 | 2026-10-25 | Weh 拍板 Q1–Q10；Q5 全自动；Q9→US-14b 入 B；拟建 milestone/issue 清单；开放项仅 Q9a |
| v3 | 2026-10-25 | **关闭 Q9a**：选 B 仅「组织 ADMIN」；须新增组织 ADMIN 角色，与 registerHuman（任一项目 ADMIN）不对称；同步阶段 B/UI/拟建 issue |
| v3.1 | 2026-10-27 | **M5 已完成**：US-14 / US-14b / US-15 状态同步（`19e3428` / `d69cc2d` / `f5e63a8`）；不宣称 US-5、Stage C、登录刷新保持、组织 ADMIN 授予/撤销与账号恢复已完成 |

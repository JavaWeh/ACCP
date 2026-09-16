# M4 真实客户端联合验收记录（2026-09-16）

## 结论与范围

Claude Desktop 与 Codex CLI 已完成“API 契约 → 人工接受 API → 下游实现与测试 → 完成候选”的真实 MCP 协作，JavaWeh 在查看具体成果后明确接受两项 Task 并保留本记录中的限制，服务端均已进入 `DONE`。两个临时 Session 随后撤销，后续访问均返回 `401 SESSION_INACTIVE`。

本次是一位真实操作者 JavaWeh 使用 Alice 开发身份，连接两个独立 Agent/Session。订单、接口及测试均为合成数据，未访问生产服务。本文记录经过核验的事实；原始客户端日志、凭证、配置和内部 skills 保留本机，不进入公共仓库。

| 项目 | 记录 |
| --- | --- |
| 上游客户端 | Claude Desktop 1.13576.1，Code 模式，内置 Claude Code 2.1.177 |
| 下游客户端 | Codex CLI 0.153.4，由实际 MCP initialize 元数据核验 |
| 协作方式 | 独立 Session、Local Bridge stdio MCP、控制面事件与冻结依赖 |
| Node 测试运行时 | v22.22.3，无外部依赖，注入模拟 fetch |
| 初始平台基线 | `5b1643140aa6e2d2df0a3b4997ebce3ac77135f2` |
| 协作缺陷修复 | [PR #7](https://github.com/JavaWeh/ACCP/pull/7)，代码修复提交 `9c2ce784df29f7cb98fa9e673b4835a6fe41eda5` |
| 本机修复镜像 | `sha256:191ca145f306b8998e204262b70eff83e1f9996da3c9cfbe9b378a090f58ede9` |

Run 的 `base_revision` 保留准备验收时的初始平台基线；实际执行叠加上述 PR 修复并使用记录的本机镜像。该字段不是生成样例的 Git Commit。样例以 DOCUMENT 保存，不作为 Git 成果核验或 CODE_READY 证据。

## 输入与来源链

| 输入 | 不可变版本 | SHA-256（含前缀） |
| --- | --- | --- |
| API | `cv_b12770c0239d2ee8ff550985e272e8e3` | `sha256:9f02034412dc5a195aebf3f3d778cd295248a34900ea915885a3537319b6e7a7` |
| Requirement / 验收要求 | `cv_ca0fb00e909665e96b766a419e37403b` | `sha256:071baa6e78831799a551d7e013f580f2185f2288d0cf50420908dd566dd07c59` |

| 阶段 | 证据 ID |
| --- | --- |
| Claude Task | `task_72fa1cad2344003e12204788c715c64c` |
| Claude 成功 Run / Snapshot | `run_470e876cb5d03a2cc5b41425fb63761c` / `snapshot_18e65743c9c842739b4d77cef45fc95e` |
| 已接受 API Artifact | `artifact_31449df2f67c10ea46f832e7081fce4a`，验收后 version 2 |
| API 人工审核 | `artifactreview_7f1f588f42eff4c5e1c500787286a2ff` |
| Claude 最终 Task 审核 | `taskreview_c560270284ef2ee81ed24d6a4570d6ac` |
| Codex 最终 Task 审核 | `taskreview_50b84f3daa1a7029aad6f48464d06675` |
| Claude TASK_COMPLETED | `event_0265f55d9f05a4d8f94c71c7e50ad728` |
| Codex TASK_COMPLETED | `event_ca5457b52ee662d4cf1c10c2565131c1` |
| API_READY | `event_ee9a97a12b8312508cba88cdfd13687b` |
| Codex Task | `task_504e8327eed37f21535cff257e31f553` |
| Codex 成功 Run / Snapshot | `run_d559a20f38481e6800083d4e13176af2` / `snapshot_3b8a510a6fe400f29b23e3bb8423f2c1` |
| Codex 源码 DOCUMENT | `artifact_5e9501bbfc9dc30e55c3d031b17cd578` |
| Codex TEST_REPORT | `artifact_d54be8ebc981b389170dde205a447b12` |

Codex 快照包含已接受的 API Artifact ID、版本、摘要及对应 API ContextVersion；其两个成果的 `parent_artifact_ids` 指向该 API。服务端保存各自的 Owner、委托人、Agent、Session、Run 和 Snapshot，子成果没有继承或伪造上游执行身份。

## 已验证结果

- API 未接受时，真实 Codex claim 返回 `409 NO_CLAIMABLE_TASK`，没有生成 Run。
- Claude 通过冻结 entry 读取版本和正文，上传与 API Context 逐字节一致的 API_DOCUMENT，并提交覆盖 200、400、404 的接入说明。
- JavaWeh 接受 API 后，控制面产生 API_READY，Worker 解除依赖，下游 Task 由 BLOCKED 进入 READY。
- Codex 实现 `fetchOrder(orderId, baseUrl, fetcher)`，实际运行 `node --experimental-strip-types --test order-client.test.ts`，16 项通过，退出码 0。包括成功响应、400/404 状态及错误码、畸形 JSON/字段、网络异常原样传播和非 JSON 的 HTTP 500。
- 从服务端成果提取源码与测试独立执行，同样 16 项通过；报告内 TAP 输出与真实 Codex 成功命令的输出一致。
- 同一上传请求保留键、正文、Run version 和 fencing token，重复执行得到相同 URI 和摘要。成果登记没有通过新键制造重复成果。
- Agent 的完成报告使 Run 进入 SUCCEEDED、Task 进入 IN_REVIEW，没有自行完成最终人工验收。Owner 明确接受后，两项 Task 才进入 DONE，审核记录保留本次限制。

最终 Codex 源码 DOCUMENT 摘要为 `sha256:62c541220259fd1a8500d3362bceb0d5c5c2c0b13861d31b0271aa88ad5e6283`；TEST_REPORT 摘要为 `sha256:c58a4891a8c4bb918a28e9e6a6c86edbb38ef254e4f48b6f9e286ca7d25fae03`。

## 失败、修复与限制

1. 早期 Bridge 缺少 ContextVersion 读取工具。真实客户端猜测正文 ID 得到 404；已补工具、CLI 参数传递和真实传输测试。
2. Claude 等待工具确认时租约过期，旧 Run 被记为 LOST；旧成果审核被 `409 RUN_NOT_REVIEWABLE` 拒绝。第三次有效 Run 重新提交，API 摘要核验一致后记录用户的内容验收决定。
3. Codex 发现成果登记仍要求父成果属于当前 Run，返回 `422 INVALID_PARENT`。修复后只允许当前 Run 成果或冻结快照中匹配的已核验、已接受依赖成果；任意跨 Run 引用仍被拒绝。
4. Bridge 的通用 body 缺少字段说明，引发无效请求；补全工具描述和[写入参数](client-joint-acceptance.md#写入参数)。最终工具使用还结合了明确契约提示，不能据此声称任意客户端均可无配置接入。
5. 一次 Codex 模型服务 TLS 连接失败使自动权限审查超时，Run 随后 LOST。网络恢复后新建 Run 重跑，未延长旧租约或抹除失败记录。超时并非审查作出的拒绝决定。
6. 成功 Run 的部分心跳间隔超过 30 秒目标（约 35、55、42 秒），但续租均在 90 秒租约内完成。心跳目标未完全达标，需在后续 Adapter 可靠性工作中改进，不能标为严格时序符合性通过。

测试是 TypeScript 运行时验证，未执行独立类型检查。三位真实成员协作、企业 OIDC、Git Provider 真实核验、高风险 Gateway 操作、生产部署和恢复演练均未在本次样例覆盖。MVP 的 M01 多成员完整验收项仍不能整体标为通过。

## 工程验证与收尾

`go test ./...`、`go vet ./...`、真实 PostgreSQL/NATS 完整集成测试、MCP stdio/CLI 回归、镜像构建和 `npm run check` 均通过。新测试覆盖冻结父成果、同 Run 来源链、未入快照成果拒绝、幂等登记和已接受版本不可变。私有路径与完整历史检查通过。

修复提交的 [文档/契约 CI](https://github.com/JavaWeh/ACCP/actions/runs/35047805181)、[控制面 CI](https://github.com/JavaWeh/ACCP/actions/runs/35047805152)、[Web CI](https://github.com/JavaWeh/ACCP/actions/runs/35047805127) 全部通过。GitNexus 综合影响检查为 HIGH，涉及成果登记和 Bridge 入口的 6 条流程；相应集成回归已完成。

两项 Task 最终审核已记录。两个临时 Session 均为 REVOKED，随后读取各自 Task 均返回 `401 SESSION_INACTIVE`；已移除本次临时 Claude MCP 配置入口。API 与审计记录继续保留，旧 LOST Run 未被改写。PR 保持人工审核与合并，本次结果不表示整个 MVP 已验收完成。

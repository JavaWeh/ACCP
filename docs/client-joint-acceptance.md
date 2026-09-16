# 真实客户端联合验收

此流程验证两个真实 AI 客户端通过同一 ACCP 协议完成任务协作。SDK 测试、脚本直接调用和模型自报不构成真实客户端兼容性证据。

## 验收准备

1. 使用部署好的 ACCP API、Worker、PostgreSQL 和 NATS，确认 `/readyz` 正常。
2. 人类创建标记明确的合成需求和 API Context，发布不可变版本；不使用真实订单或生产资源。
3. 登记两个 Agent，记录实际客户端版本、Adapter manifest、启动方式和 MCP 握手信息。
4. 创建两项有人类 Owner 的任务：API 契约成果、接入实现与测试。第二项依赖第一项的 `API_DOCUMENT` 被接受。
5. 创建两个有期限的 Session，权限限定为任务读取、Context 读取、领取、Run 写入、成果登记和事件读取。凭证只在本机忽略目录或凭证存储中保存。

单个操作者切换开发账户不能作为多位真实成员参与的证据。实际参与人数、客户端运行模式及未覆盖边界均须写入验收记录。

## 客户端接入

编译并配置 [Local Bridge](m2-execution.md#使用-local-bridge-和-go-sdk)。每个客户端使用独立 manifest 和 Session。不要将人类访问令牌交给 Bridge。

- Claude Desktop 的普通聊天与 Code 模式使用不同配置入口。Code 模式可使用当前项目的本机 MCP 配置；验收记录应同时记录 Desktop 版本和内置执行引擎版本。[官方说明](https://code.claude.com/docs/en/mcp)
- Codex 支持 stdio MCP；单次执行可单独配置 MCP 服务并输出 JSONL 调用记录。保留沙箱与工具审批规则，不将禁止审批的非交互模式报错视为服务器拒绝。[MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[非交互执行](https://learn.chatgpt.com/docs/non-interactive-mode)

配置变化后重启 MCP 连接，确认 `tools/list` 中包含 `accp_context_version`。客户端凭证、配置、聊天记录和原始日志不提交公共仓库。

### 写入参数

Bridge 将 `body` 作为 REST 正文发送；外层 `id`、`version`、`fencing_token`、`idempotency_key` 用于路径和请求头。以下正文不允许额外字段：

| 工具 | `body` 必填内容 |
| --- | --- |
| `accp_claim` | `project_id`、`base_revision`；可选 `task_id` 指定任务 |
| `accp_heartbeat` | `observed_at`：真实 RFC3339 时间 |
| `accp_artifact_upload` | `content`、`media_type` |
| `accp_artifact_register` | `kind`、`uri`、`content_digest`、`media_type`；可选 `parent_artifact_ids`、`context_version_id`、`immutable_revision` |
| `accp_report` 完成候选 | `kind: COMPLETION_CANDIDATE`、`artifact_ids`、字符串 `acceptance_report` |
| `accp_report` 失败 | `kind: FAILURE`、`error_code`、字符串 `message` |

除 claim 外，写入使用外层 `id=<Run ID>`、最近一次前台 Run 响应的 `version`、claim 返回的 `fencing_token` 及本步骤幂等键。上传和登记不会改变 Run version；显式心跳返回的 `body.run.version`、报告返回的 `body.version` 必须用于后续新写入。常驻 stdio Bridge 会补偿自身后台心跳的版本推进；未知结果重试仍须保持所有工具参数不变。不要把文件名、Run ID 或自报来源信息添加到正文。完整约束见 [领域契约](../contracts/schemas/domain.schema.json) 和 [自动续租边界](m2-execution.md#使用-local-bridge-和-go-sdk)。

## 完整流程

1. 第二客户端先尝试领取依赖未满足的任务，预期 `409 NO_CLAIMABLE_TASK`，且无 Run 被创建。
2. 第一客户端领取 API 任务，得到 Run、租约、fencing token 和 ContextSnapshot。
3. 通过 `accp_snapshot` 读取 entry；用 entry 的 `context_id`、`context_version_id` 调用 `accp_context_version`；从返回的 `urn:accp:content:<content_id>` 读取正文。核对版本和摘要，禁止猜测正文 ID 或替换为最新版本。
4. 常驻 stdio Bridge 后台续租；验证无工具调用等待超过 90 秒后 Run 仍有效，并记录实际心跳间隔。CLI/直接 SDK 调用方仍每 30 秒显式心跳。检查断开、撤销、网络中断和 30 分钟 Run 工具空闲上限；续租停止或租约过期后停止执行，保留旧 Run，由人类决定后续尝试。自动化回归不能代替指定版本真实客户端的再次验收。
5. 第一客户端提交与已发布 API Context 字节一致的 API_DOCUMENT，以及接入说明；上报 `COMPLETION_CANDIDATE`，任务停留在 IN_REVIEW。
6. 人类查看具体成果正文、版本和摘要后接受 API 成果或验收任务。控制面产生 API_READY，依赖解除。
7. 第二客户端领取任务，确认快照包含已接受的 API 成果引用和对应的 Context 版本，完成接入实现并运行测试。
8. 第二客户端登记源文件与测试报告，父成果关联 API Artifact。对一次上传复用完全相同的幂等键、请求体、Run version 和 fence，验证回执一致。
9. 第二客户端提交完成候选，Owner 查看代码、测试证据及来源链，接受或退回。Agent 不能代替这一步。
10. 撤销两个临时 Session，核实后续访问被拒绝；收集脱敏审计与事件证据。

没有实际 Commit 的本地样例代码应作为 DOCUMENT 归档，不能将平台的基线 SHA 冒充为样例代码 Commit，也不能宣称 Git 核验或 CODE_READY 已通过。

## 证据与判定

| 验收项 | 必须提供的证据 |
| --- | --- |
| 两个真实客户端 | 实际启动记录、客户端版本、MCP initialize 和 tools/call 元数据 |
| 人类责任 | Owner、委托人、实际操作者及人工审核决定 |
| 依赖阻塞与释放 | 拒绝领取审计、API 成果验收、API_READY、后继 Run |
| 冻结输入 | Snapshot ID、ContextVersion ID、内容摘要及父成果引用 |
| 可验证成果 | 原始正文摘要、源文件、实际测试命令、输出和退出码 |
| 幂等与恢复 | 重复请求回执、失败尝试及重试 Run 记录 |
| 完成边界 | Agent 提交后 IN_REVIEW；人类接受后 DONE |
| 授权撤销 | Session 撤销记录及随后访问被拒绝的证据 |

区分已通过、失败、未执行、待人工确认。读取页面或 `/readyz` 成功只证明对应入口可用。高风险 Gateway 操作、Git Provider 核验、多位真实成员、企业 OIDC 和生产部署仍需各自验收，不能由上述样例推导为已通过。

# CLI Adapter 接入指南（`accp-bridge`）

面向需要让**非 MCP agent / 脚本 / 一次性进程**接入 ACCP 的集成者。本文记录
已经存在、已验证的 `accp-bridge` 一次性 CLI 路径——不引入新的运行时代码。

- 二进制来源：`cmd/accp-bridge/`（`go build ./cmd/accp-bridge/`）。
- 契约：[`contracts/schemas/adapter.schema.json`](../contracts/schemas/adapter.schema.json)、
  [Adapter 握手与能力](protocol.md#adapter-握手与能力)。
- 参考 manifest：[`examples/cli-adapter/manifest.json`](../examples/cli-adapter/manifest.json)。

## 1. 两种接入模式（同一个二进制）

`accp-bridge` 用同一套 MCP 工具定义同时提供两种接入形态：

| 模式 | 调用 | 用途 | 租约续期 |
| --- | --- | --- | --- |
| stdio / MCP | `accp-bridge` 或 `accp-bridge stdio` | 长连接 MCP 客户端（Claude Desktop、Codex CLI 等）；连接期自动续租 | **自动**（`NewWithAutoHeartbeat`，KeepAlive 20s，Run 工具空闲上限 30 分钟） |
| 一次性 CLI | `accp-bridge call <TOOL> < input.json` | 脚本 / CI / 非 MCP agent 以进程参数化方式调用单个工具 | **无**——调用者必须自管心跳（见 §5） |

两种模式**启动即握手**：读取 `ACCP_ADAPTER_MANIFEST` 指向的 JSON（≤64 KiB）→
`POST /api/v1/adapters/handshake`。握手失败进程直接退出，不会执行任何工具。

## 2. 前置条件

1. **人类委托人已登记 agent manifest**。委托人（项目 MEMBER）以 `POST /api/v1/agents`
   提交 `{project_id, manifest}`（schema `M2AgentRegistration`，参考
   [`contracts/examples/valid/m2-register.json`](../contracts/examples/valid/m2-register.json)）。
   登记的 manifest 会被服务端原样保存在 `agents` 表。
2. **拿到一个委托 Session token**（`accp_s_` 前缀）。token 代表某个人类委托人授权的
   agent 会话，由控制面签发。
3. **本机能访问控制面**：loopback HTTP 或 HTTPS（客户端强制，见 §3）。

> 关键不变量：握手时提交的 manifest 必须与第 1 步登记在 `agents` 表的那份**内容一致**
> （服务端对双方 JSON 做规范化后逐字段比较，键顺序无关、值必须相同），否则返回
> `409 MANIFEST_MISMATCH`。实践上：**让 `ACCP_ADAPTER_MANIFEST` 指向登记时用的同一个文件**。

## 3. 环境变量

| 变量 | 含义 | 约束（来自 `pkg/client/client.go`） |
| --- | --- | --- |
| `ACCP_URL` | 控制面 origin | 只能是 scheme+host，**不含** path/query/fragment/凭证；非 loopback 必须 HTTPS，loopback 允许 HTTP。客户端自动追加 `/api/v1`。 |
| `ACCP_SESSION_TOKEN` | 委托 Session token | 必须 `accp_s_` 前缀，不含换行。 |
| `ACCP_ADAPTER_MANIFEST` | manifest JSON 文件路径 | 文件 ≤64 KiB，合法 JSON；缺失或超限直接报错退出。 |

示例（本地 compose，端口见 `compose.yaml` 的 `127.0.0.1:${ACCP_HTTP_PORT:-8080}:8080`）：

```sh
export ACCP_URL=http://127.0.0.1:8080
export ACCP_SESSION_TOKEN=accp_s_...        # 委托人授权签发，勿入库/日志
export ACCP_ADAPTER_MANIFEST=/abs/path/to/manifest.json
```

## 4. 一次性 CLI 调用

```sh
echo '{"id":"task_cafde1d3e90739e179fb3f8dac3c14e8"}' \
  | accp-bridge call accp_task
```

行为（`cmd/accp-bridge/main.go`）：

- stdin JSON 作为工具参数（≤1 MiB），经**内存 transport** 复用同一套 MCP 工具定义调用。
- stdout 输出一个 MCP `CallToolResult`（JSON）。
- 工具失败（`result.IsError=true`）时进程**退出码 1**；成功为 0。
- 调用前仍会先完成一次握手。

### 只读工具（适合作为验收 / 探活）

无需 Run 租约、不产生副作用，适合一次性调用验证接入：

| 工具 | 读取对象 | 典型输入 |
| --- | --- | --- |
| `accp_task` | 一个 Task 的权威状态 | `{"id":"task_..."}` |
| `accp_run` | 一个属主 Run | `{"id":"run_..."}` |
| `accp_events` | 项目事件（可续 cursor） | `{"project_id":"project_...","cursor":""}` |
| `accp_snapshot` | 绑定 Run 的不可变 Context 快照 | `{"id":"snapshot_..."}` |
| `accp_context_version` | 快照条目指向的精确 Context 版本 | `{"context_id":"ctx_...","context_version_id":"cv_..."}` |
| `accp_context_content` | Context 正文（按 content ID） | `{"id":"content_..."}` |

写入 / 租约类工具（`accp_claim`、`accp_heartbeat`、`accp_report`、`accp_artifact_upload`、
`accp_artifact_register`）也可经 `call` 调用，但涉及租约语义，见 §5。

## 5. ⚠️ 一次性模式不自动续租

**只有 stdio 模式后台自动续租**（`internal/bridge/bridge.go` 的 `NewWithAutoHeartbeat`）。
`accp-bridge call` 是一次性进程，**不**后台续租。因此：

- 一旦用 `call accp_claim` 领到 Run，调用者**必须自己每 30 秒** `call accp_heartbeat`
  （携带返回的 Run `id` / `version` / `fencing_token`），否则 90 秒后租约到期、Run 标 LOST。
- 这一约束同样写在 `accp_claim` / `accp_heartbeat` 的工具描述里。租约丢失不可恢复。
- 因此一次性 CLI 路径最适合**只读探活 / 短读取**；需要持有 Run 执行的 agent 应走 stdio，
  或自行实现心跳调度器。

## 6. 失败态

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `409 MANIFEST_MISMATCH` | 握手 manifest 与 `agents` 表登记的不一致 | 让 `ACCP_ADAPTER_MANIFEST` 指向登记时的同一文件 |
| `provide a bounded ACCP_ADAPTER_MANIFEST JSON file` | manifest 文件缺失或 >64 KiB | 修正路径 / 文件大小 |
| `a delegated ACCP Session token is required` | token 不以 `accp_s_` 开头 | 使用委托人签发的 Session token |
| `ACCP requires HTTPS or loopback HTTP` | `ACCP_URL` 非 loopback 却用了 http | 用 HTTPS |
| `ACCP tool failed` + 退出码 1 | 工具返回 `IsError` | 读 stdout `CallToolResult` 内容定位 |

## 7. 已知契约漂移（本切片只点名，不修）

`contracts/schemas/adapter.schema.json` 与当前服务端实现存在两处不一致，F9 薄切片**不**
顺带改契约（避免扩大爆炸半径），另立契约修订处理：

1. **`mcp_uri`**：schema 的 `HandshakeResponse` 把 `mcp_uri` 列为 required，但服务端
   （`internal/controlplane/sessions.go` 的 `handshake`）只回 `protocol_version` /
   `accepted_capabilities` / `api_base_uri`，不含 `mcp_uri`。
2. **`protocol_versions` enum**：schema 的 `Manifest.protocol_versions` enum 仅 `"0.1"`，
   而服务端协商 `"0.2"`，`contracts/examples/valid/m2-manifest.json` 与本文参考 manifest
   均用 `"0.2"`。以服务端协商的 `0.2` 为准。

因此参考 manifest 用 `"0.2"` 与运行时一致；它能通过握手，但**不**与 schema 当前的
`0.1` enum 相符——这是上述 (2) 的已知漂移，不是样例错误。

## 8. 验收证据

一次性 CLI 握手 + 只读工具调用的可复跑记录见
[`.handoff/wave-f9-cli-adapter.md`](../.handoff/wave-f9-cli-adapter.md)。

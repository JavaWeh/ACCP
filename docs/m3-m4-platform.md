# M3 / M4：受控交付与协作平台

M3 补齐成果核验、人工验收和工具审批；M4 提供实际连接这些接口的 React 控制台。Claude Desktop 与 Codex 的单人双客户端样例已完成人工验收；实际版本、失败恢复及心跳时序限制见 [M4 联合验收记录](acceptance-2026-09-16.md)。

## 运行与升级

首次部署按 [M2 初始化步骤](m2-execution.md) 生成配置、启动并 bootstrap。已有 M1/M2 环境保留原 Compose 项目名和 PostgreSQL 卷，不要再次 bootstrap：

```sh
node scripts/dev-env.mjs --upgrade-m2
docker compose --env-file .accp-local/compose.env build
docker compose --env-file .accp-local/compose.env stop api worker
docker compose --env-file .accp-local/compose.env up -d --no-build
```

迁移 003 新增审核、核验、工具、审批及审计字段，保留已有数据。升级前停止旧版本 API/Worker，避免混用迁移版本。数据保护与恢复策略由部署操作者制定。

浏览器打开 `ACCP_PUBLIC_URL` 的根路径即可进入平台。`/healthz` 只检查 HTTP，`/readyz` 检查数据库与迁移；完整链路需要 smoke、Worker/NATS 和浏览器验证。

开发环境从忽略目录 `.accp-local/dev-users.json` 读取个人凭证，在登录页输入。凭证不在 URL、公共文件或浏览器持久存储中保存。生产需要真实 OIDC issuer、与 API audience 一致的公共 SPA client ID，并登记 `<ACCP_PUBLIC_URL>/auth/callback` 重定向地址。

## 界面验收路径

1. **共享上下文**：创建 API、需求或规范的候选版本；审核人查看正文并发布。
2. **任务协作**：指定人类 Owner、仓库、验收条件、已发布 Context；配置依赖并提交执行。
3. **执行代理**：登记真实客户端信息，通过 Local Bridge 接入；为指定 Agent 创建短期 Session，选择所需权限。
4. **执行与成果**：Agent 领取、心跳、读取快照、上传成果并上报完成候选。任务进入 IN_REVIEW。
5. **交付成果**：查看正文、Commit、来源链；审核人核验 Git 并接受 API 成果。Task Owner 逐项检查验收条件，接受或退回。
6. **审批中心**：另一位审核人检查资源、参数、Commit、成果与有效期；批准绑定的工具操作。
7. **工具网关 / 审计记录**：查看执行结果、查询不明结果、追踪责任人、Session、快照、审核及拒绝记录。

本地复验 M2 基础流程：

```sh
node scripts/m2-smoke.mjs http://127.0.0.1:18080
```

该工具生成待验收任务；可在 Web「任务协作 → 成果与验收」由 Bob 逐项确认并完成任务。每次运行会创建独立验收数据。

## Git 成果核验

首个 Provider 是 GitHub，领域层使用 `gitprovider.Provider` 接口。Repository URL 必须匹配登记的 GitHub 仓库；Commit/PR 绑定完整 40 位 SHA。PR 在读取 diff 前后均检查 head，拒绝变更中的引用。

`content_digest` 是 GitHub REST 返回 `application/vnd.github.diff` 原始字节的 SHA-256；它不是 Commit SHA，也不能随意用本地 `git diff` 的摘要代替。提供方核验只证明引用和内容一致，测试是否真正运行、业务是否正确仍需人类审核。

已接受成果不可被再次核验或改写；新的成果版本需要新 Artifact。API 成果必须与已发布 API Context 的正文摘要匹配，接受后才产生 API_READY。Git 核验成功产生 CODE_READY，Owner 接受任务产生 TASK_COMPLETED。

## 工具配置与 MCP Gateway

默认 [工具配置](../configs/tools.json) 是空目录。复制 [GitHub 合并示例](../configs/tools.example.json) 到忽略目录，配置自己的项目、仓库和参数 Schema，通过 `ACCP_TOOLS_CONFIG` 指定文件。API 与 Worker 必须使用同一份配置。

GitHub 凭证通过 `ACCP_GITHUB_TOKEN` 注入，只有提供方模块使用。自有 MCP 服务通过 `kind: mcp` 配置 `endpoint`、`tool_name`、`resource_id`、`input_schema`、`credential_env` 和可选 `reconcile_tool`；凭证由部署器单独注入 API/Worker 环境。生产端点要求 HTTPS；重定向和远程 Schema 引用被拒绝。登记企业内部地址等同于操作者将该端点加入允许列表。

项目 ADMIN 在 Web 注册策略并选择资源版本。`read_only` 由受信配置控制，其他操作一律按 HIGH 处理。修改工具配置或策略后，旧的待执行审批失效。

Agent Session 需包含 `tools:invoke`。使用 `GET /agent-sessions/{id}/gateway-token` 获取只面向 `<ACCP_PUBLIC_URL>/mcp` 的凭证；API Session token 与 Gateway token 不能相互替用。网关采用 MCP Streamable HTTP，工具包括：

| 工具 | 功能 |
| --- | --- |
| `accp_tools` | 读取本项目工具目录、版本与参数 Schema |
| `accp_tool_request` | 提交 `run_id`、当前 `version` / `fencing_token`、幂等键、工具与资源版本、参数和成果引用 |
| `accp_tool_result` | 读取操作状态、结果和摘要；不能将持久化回执当作成功结果 |

网关返回异步回执：高风险操作为 AWAITING_APPROVAL，批准后由 Worker 执行。等待审批期间，客户端仍需按 30 秒周期心跳；审批不延长 Run 租约。

GitHub 合并使用提供方原子的 head SHA 前置条件；分支保护、必需检查及基础分支并发更新由 Git 服务管理，ACCP 不宣称能跨系统锁住 Git 分支。

下游 MCP 工具接收 `{ arguments, operation_id, resource_id, resource_version }`，需要自行强制资源版本前置条件，并按 `operation_id` 幂等处理。返回有界的 `structuredContent`。核对工具返回 `state: SUCCEEDED | FAILED`，无法确定时维持 UNKNOWN。平台不会把下游的说明文字当作额外授权。

## 已验证边界与后续验收

- 运行时测试覆盖 Owner/审批人分离、证据版本、不可变审核、依赖快照、租约、撤销、配置漂移、真实 MCP 调用、未知结果不重试。
- Web 浏览器测试连接真实 API/数据库，覆盖登录、Context 发布、任务创建/提交、Owner 接受成果、Session 授权/撤销、页面导航与移动端布局。
- 自有系统 MCP 需要实施上述操作 ID 和版本约定；不是任意第三方工具接入后都自动获得恰好一次执行保证。
- 无法认证到人类或 Session 的请求不能伪造责任人；项目审计记录已识别主体的拒绝，反向代理负责匿名流量与访问日志。
- 实际企业 IdP 联调、两种真实 AI 客户端联合验收、生产容量与运维演练按部署场景完成。集中 Runner、跨企业 SaaS、大对象存储、完整 OTel 导出和跨区域容灾不在本阶段实现中。

参见 [ADR 0006](adr/0006-controlled-delivery-console.md)、[治理](governance.md) 和 [OpenAPI](../contracts/openapi.yaml)。

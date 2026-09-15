# M1：人类控制面基础

## 交付边界

M1 提供可运行的 Go HTTP API、PostgreSQL 迁移、OIDC 验证、预置人类身份、项目角色、Task 草稿与提交/取消、Context 内容及候选版本/人工发布、成功写入审计和发布 Outbox。

Agent 注册与 Session、TaskRun、依赖 DAG、执行快照、重试执行、成果验收、事件投递、MCP Gateway、React 界面均留在后续阶段。OpenAPI 用 `x-accp-milestone: M1` 标出已实现接口；其他目标接口在 M1 返回 404，`RETRY` 命令返回 501。

## 本地启动

需要 Docker Engine、Docker Compose v2 和 Node.js 22。Node 仅用于生成本地随机配置；业务进程为 Go。首次执行：

```sh
node scripts/dev-env.mjs
docker compose --env-file .accp-local/compose.env up --build -d
docker compose --env-file .accp-local/compose.env --profile tools run --rm bootstrap
```

API 监听 `http://127.0.0.1:8080`；`GET /healthz` 检查进程，`GET /readyz` 检查数据库与迁移校验和。数据库不发布主机端口。持久数据保存在 Compose 命名卷中。

如果主机端口被占用或被 Windows 保留，在 `.accp-local/compose.env` 中加入 `ACCP_HTTP_PORT=18080`，重新运行 `up -d`；访问地址相应改为 `http://127.0.0.1:18080`。

Bootstrap 只接受空数据库，建立 `org_demo`、`project_demo`、`repo_demo`、`user_alice` 和 `user_bob`：Alice 是 ADMIN/MEMBER/REVIEWER，Bob 是 MEMBER/REVIEWER。随机 bearer token 写入 `.accp-local/dev-users.json`，不打印到日志；数据库仅存 SHA-256 摘要，令牌有效期七天。文件在 POSIX 上以 0600 创建；Windows 用户应使用目录 ACL 限制访问。

再次启动直接运行 `docker compose --env-file .accp-local/compose.env up -d`，不重复生成配置或运行 bootstrap。停止使用 `docker compose --env-file .accp-local/compose.env down`，不加 `-v`，保留数据。配置生成器和凭证输出都拒绝覆盖已有文件。

开发令牌不提供在线续期。需要长期身份时使用 OIDC；丢失或过期的演示凭证由操作者处理，服务不会自动重置成员或数据库。

### 两名成员的 API 操作顺序

各请求使用对应成员的 `Authorization: Bearer <token>`。POST 使用新的 `Idempotency-Key`（8–128 字符）；重试同一请求保留原 key、正文与 `If-Match`。示例不含真实凭证：

1. Alice 调用 `GET /api/v1/me`、`GET /api/v1/projects`，确认身份及项目。
2. Alice 向 `POST /api/v1/projects/project_demo/contents` 提交 `{"content":"# Orders API","media_type":"text/markdown"}`，保存返回的 URI 与 digest。
3. Alice 向 `POST /api/v1/projects/project_demo/contexts` 提交 `{"type":"API","name":"Orders API","source":{"kind":"ACCP","canonical_uri":"urn:accp:orders-api"}}`，保存 Context ID 和 ETag。
4. Alice 向 `POST /api/v1/contexts/{id}/versions` 提交下面正文，携带父 Context 的 `If-Match`。
5. Bob 向 `POST /api/v1/contexts/{id}/versions/{version}/publish` 发送空正文，携带候选版本的 `If-Match`，完成人工发布。
6. Alice 创建 Task，Owner 指向 `user_bob`，绑定已发布版本；Bob 使用 Task ETag 发送 `SUBMIT` 命令，Task 进入 `READY`。

候选版本请求（替换为上传返回的值）：

```json
{
  "source_revision": "1",
  "content_uri": "urn:accp:content:content_example",
  "content_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "media_type": "text/markdown",
  "change_summary": "订单查询接口初稿"
}
```

Task 请求：

```json
{
  "title": "实现订单查询 API",
  "objective": "按照已发布 API 实现查询能力",
  "owner_user_id": "user_bob",
  "repository_id": "repo_demo",
  "acceptance_criteria": ["返回符合规范的订单列表"],
  "context_version_ids": ["cv_example"]
}
```

提交命令为 `{"command":"SUBMIT","reason":"输入已经确认"}`。如果引用候选版本，提交后为 `BLOCKED`；版本发布后由 Owner 再次提交，进入 `READY`。M1 不自动启动 Agent，也不能把任务改成 `DONE`。

## 身份与私有部署

生产默认使用 OIDC，必须配置 `DATABASE_URL`、`ACCP_OIDC_ISSUER`（HTTPS）与 `ACCP_OIDC_AUDIENCE`（专门分配给 ACCP API 的 audience）。验证器读取 discovery/JWKS，检查 RS256 签名、issuer、audience、有效期和 subject。只接受 IdP 为该 API 签发的 JWT bearer；不支持 opaque token。不要将 Web 登录客户端 ID 当作 API audience。

身份先由操作者确认，再用 `(issuer, subject)` 映射到独立的人类表。请求正文、邮件、显示名或自报 `kind` 不能建立可信人类身份；未映射的机器账号/Agent token 被拒绝。M1 不提供公开注册接口。

先执行 `accp migrate`，然后执行 `accp bootstrap -file <private-json>`，最后启动 `accp serve`。下面是人工维护的 bootstrap 文件结构，文件应放入本地私有目录并使用真实的人类 OIDC subject：

```json
{
  "organization": {"id": "org_company", "name": "Company"},
  "projects": [{
    "id": "project_orders", "name": "Orders",
    "repository": {
      "id": "repo_orders", "provider_id": "git",
      "url": "https://git.example.com/team/orders", "default_branch": "main"
    }
  }],
  "humans": [{
    "id": "user_owner", "issuer": "https://identity.example.com",
    "subject": "verified-human-subject", "display_name": "Owner",
    "memberships": [{"project_id": "project_orders", "roles": ["ADMIN", "MEMBER", "REVIEWER"]}]
  }]
}
```

部署需要 TLS 反向代理和启用 TLS 的数据库连接；Compose 是仅绑定 localhost 的开发配置。迁移使用有 DDL 权限的操作者账户；生产服务使用单独的数据库角色，只授予业务表所需 SELECT/INSERT/UPDATE 与迁移表 SELECT 权限，禁止 DDL 和删除内容/版本/审计。数据库管理员仍可破坏数据，M1 不声称数据库级防篡改证明。

开发认证必须同时显式设置 `ACCP_ENV=development` 和 `ACCP_AUTH_MODE=development`。生产环境配置开发认证时，进程拒绝启动。

### 权限矩阵

| 操作 | 必要条件 |
| --- | --- |
| 读取项目、Task、Context、正文 | 当前活跃人类与项目成员关系 |
| 创建 Task、上传正文、创建 Context/版本 | MEMBER 或 ADMIN |
| Task SUBMIT/CANCEL | 当前 Owner 或 ADMIN |
| 发布 Context、查看成功写入审计 | REVIEWER 或 ADMIN |
| 修改已有成员角色/停用状态 | ADMIN；不得移除最后一个活跃 ADMIN |

成员角色和停用接口不创建新身份；新组织、项目和成员通过首次操作者 bootstrap 预置。自助项目创建、邀请与企业目录同步后续实现。权限每次重新检查，幂等响应重放也不例外。跨项目不存在成员关系时返回 404，减少资源存在性泄露。

## 数据与一致性

- Context 正文限 UTF-8 文本 256 KiB，无 NUL；支持 plain text、Markdown、JSON、YAML。JSON/YAML 在此作为文本存储，不宣称已验证其业务语义。
- M1 仅接受 ACCP 管理来源。`canonical_uri` 是标识标签；不会下载远程 URL。版本必须引用同项目已上传内容，服务端计算并校验摘要与媒体类型。
- 创建版本递增父 Context 的版本号，发布检查候选版本号，再递增父 Context 并更新已发布指针。旧正文和版本保留，不覆盖内容；重复发布需使用原幂等键，否则返回版本/状态冲突。
- 数据库外键验证组织、项目、Owner、Repository 和 Context 的关联；唯一约束限制一个 Task 对同一 Context 只选择一个版本。
- M1 使用项目行锁串行化项目写入，权限、版本、业务状态、审计及幂等结果同一事务提交。响应丢失后可按原 key 重试。幂等响应有效 24 小时，过期同 key 可被新请求替换；清理任务后续补充。
- 发布的 `CONTEXT_PUBLISHED` CloudEvent 同事务写入 Outbox，但 M1 没有投递 Worker。没有 SSE/NATS 运行时，不应把 Outbox 记录当作已送达通知。
- 审计保存成功写入的实际人类主体、项目、操作、资源、版本和请求关联 ID。拒绝请求不写入领域审计；部署方可收集不含 Authorization/正文的反向代理访问日志。完整拒绝审计、OTel、TaskRun 证据链后续补齐。
- ID 顺序游标用于稳定分页，不代表时间顺序；分页期间新增资源可能在已有游标之前，重新查询可见。所有分页带 `next_cursor`，结束时为 null。

## 开发与验证

安装 Go 1.27.1、Node.js 22 与 PostgreSQL 17。设置 `DATABASE_URL` 后运行迁移和服务；本机设置环境变量的方式按所用 shell 选择。

```sh
go mod download
go run ./cmd/accp migrate
go run ./cmd/accp serve
go test ./...
go vet ./...
```

集成测试要求 `ACCP_TEST_DATABASE_URL` 指向专门的测试数据库。测试账户需要 CREATE SCHEMA 权限；每个测试创建独立随机 schema，并仅清理自己的 schema。没有该变量时，显式请求集成测试会失败，不会静默跳过。

```sh
go test -race -tags=integration -count=1 ./...
npm ci --ignore-scripts
npm run check
```

CI 在 Linux/PostgreSQL 上运行 race 检测、集成测试、模块校验、格式检查、vet、二进制和 Docker 构建。OIDC 单元测试使用本地签名/JWKS 服务验证有效、过期、篡改及错误 issuer/audience；真实企业 IdP 联调属于部署验收。

# D01–D03 部署与持续管理

本手册针对单企业、单机 Linux Docker Compose。开发 Compose 保持开发用途。安装使用 [生产 Compose](../deploy/production/compose.yaml)，权限依据 [ADR 0008](adr/0008-product-foundation.md)。发布、备份恢复、监控告警、容量和多端联合验收不由本手册宣布完成。

## 新安装

需要 Docker Compose v2、生成配置所用 Node.js、受信任 HTTPS 域名和证书、支持 RS256 JWT access token 的 OIDC 服务。IdP 创建公共 SPA 客户端，启用 Authorization Code 与 PKCE S256，禁止 password grant；redirect URI 为 `https://accp.example.com/auth/callback`，logout redirect URI 为 `https://accp.example.com`。给 access token 配置 `accp-api` audience，与客户端 `accp-web` 不同。Keycloak 使用签名 payload `typ=Bearer`；其他服务可使用签名 JOSE header `typ=at+jwt`。

以下命令在仓库根目录执行，示例 subject 须替换为 IdP 的稳定 subject，不能填写邮件地址代替。命令不打印生成的秘密。

```sh
node scripts/production-env.mjs --directory .accp-local/production \
  --public-url https://accp.example.com --issuer https://identity.example.com/realms/company \
  --client-id accp-web --audience accp-api --admin-subject REPLACE_WITH_SUBJECT \
  --repository https://github.com/example/orders
```

检查生成的 `bootstrap.json`：初始企业、项目、仓库和管理员。安装证书链到 `tls/certificate.pem`、私钥到 `tls/private.key`。生成器拒绝覆盖已有目录；不要以重新生成为方式更新现有密钥。部署目录及 secrets 父目录仅允许运维账号访问；单独挂载的 secret 文件允许容器非 root 账号只读。不要把整个部署目录挂载给应用或浏览器测试，也不要提交或上传其内容。

```sh
docker compose --env-file .accp-local/production/compose.env -f deploy/production/compose.yaml build
docker compose --env-file .accp-local/production/compose.env -f deploy/production/compose.yaml up -d
docker compose --env-file .accp-local/production/compose.env -f deploy/production/compose.yaml --profile tools run --rm bootstrap
docker compose --env-file .accp-local/production/compose.env -f deploy/production/compose.yaml --profile tools run --rm doctor
```

`postgres` 初始化四个受限登录，`migrate` 完成迁移后 `grants` 设置权限，API/Worker 再启动。bootstrap 仅执行一次，拒绝在已有数据上重复运行。生产发行时设置固定版本及摘要的 `ACCP_IMAGE`，不用构建目录的可变 tag 代替发行标识。本仓库尚未提供 D10 的正式发布流水线。

仅 Caddy 暴露 80/443；数据库、NATS、API 仅在 Compose 网络内访问。跨主机数据库或消息服务不属于此内部明文网络假设，应另配 TLS。企业 CA 可以通过只读 CA 文件与 `SSL_CERT_FILE` 注入，禁止关闭证书验证。

## 管理员日常操作

Web 的“项目管理”提供创建项目、登记企业成员、向项目添加成员、登记 GitHub 仓库、改名、归档和恢复。企业成员先登记 issuer/subject，再加入具体项目；默认没有项目访问权。现有“成员”页修改角色和启停，停用立即撤销该项目已有 Session，重新启用需签发新 Session。

归档前处理所有未完成任务、活跃执行和待处理工具调用，UNKNOWN 必须先核对；接口返回阻塞对象，不能通过归档掩盖未知副作用。已归档项目允许读取和恢复，不允许普通写入。恢复不会复活旧授权。最后一个有效 ADMIN 受到事务锁保护，不可通过并发降权绕过。

全局离岗由本机运维账号执行 `accp human-status -user USER_ID -actor ADMIN_ID -reason REASON -active=false`，连接受保护的迁移账号（该账号有全局更新所需权限），记录企业审计并撤销全部 Session。`-active=true` 只恢复人类状态，不恢复 Session。该命令不是远程用户接口，不应给 API 数据库登录增加修改 `human_users` 的权限。

## 自检与恢复

`doctor --json` 只输出检查名称和布尔值；退出码非零表示安装不完整。检查配置、OIDC discovery/JWKS、数据库、迁移、运行账号不具有建库/建角色/schema 创建/表所有权、Worker 进展、API/Worker 配置摘要、受信任公共 TLS API 和 JetStream。它不替代端到端任务测试，也不证明 IdP 已正确为每位用户分配 audience。

`healthcheck api` 检查本地 8080 的数据库与迁移就绪；`healthcheck worker` 要求事件及治理循环都在 60 秒内成功推进。当前心跳槽只支持一个 Worker。API 存活而 Worker 停止时 doctor 必须失败。Docker restart 策略只恢复退出的进程，healthcheck 不会自动重启卡死进程；收到异常需检查日志和进程，再人工重启。

PostgreSQL、JetStream 和 Caddy 状态位于命名卷。升级和维护不得使用 `down -v`。更换镜像前备份并核对版本，停止业务写入，运行迁移及 grants，再恢复 API/Worker 并执行 doctor。此版本仅提供前向迁移，没有自动降级 SQL；失败时保持停止，使用经验证的恢复方案或前向修复。完整恢复演练属于 D04。

## 密钥轮换

配置可使用 `DATABASE_URL_FILE`、`ACCP_SESSION_KEYS_FILE`、`ACCP_SESSION_KEY_FILE`、`ACCP_NATS_TOKEN_FILE`、`ACCP_GITHUB_TOKEN_FILE`。同时设置值和 `_FILE` 会启动失败；文件必须非空（未启用 GitHub 工具时允许空 GitHub token）。变更文件后重建相关容器，不能假定单个文件 bind mount 或进程自动重读。

Session keyring 格式为 `{"active":"k2","keys":{"k1":"64位十六进制旧密钥","k2":"64位十六进制新密钥"}}`，每个 key 是随机 32 字节，最多八把。先让 API/Worker 同时加载包含新旧 key 的配置，再切换 active 并一起重建，执行 doctor 确认配置一致。旧 Session 在保留旧 key 且授权仍有效时可继续使用；在最长 Session 寿命及客户端过渡窗口结束后移除旧 key。旧单密钥格式迁移可在 keyring 临时设置 `legacy`，迁移结束必须删除。紧急泄漏时直接删除泄漏 key 并重签发 Session，不能保留兼容窗口。密钥变化也影响使用同一 signer 的 Gateway 凭据。

数据库密码轮换安排维护窗口：停止 API/Worker，在受保护的操作员连接中更新对应角色密码，同时更新 `secrets/<role>_password` 和 `<role>_url` 文件，然后重建使用该登录的容器并执行 doctor。修改 secret 文件本身不会改变 PostgreSQL 内的密码；禁止把密码放到命令行、日志或工单中。NATS 当前采用单 token：同时更新 token 文件并重建 NATS/API/Worker，短暂中断后通过 JetStream 持久数据恢复；检查 doctor 与事件积压。GitHub token 先在提供方建立最小权限新 token，更新文件重建 API/Worker，验证后撤销旧 token。

## 从旧开发部署迁移

旧部署在 `public` schema 且使用统一数据库账号。不要将旧卷当空库，不要重跑 bootstrap。先在备份副本演练，停止所有旧 API/Worker/数据库客户端，记录现有卷和项目标识。生成新的生产配置目录，仅用于新角色秘密；其 bootstrap 文件不用于旧库。

`node scripts/adopt-production.mjs --container OLD_POSTGRES_CONTAINER --user OLD_OPERATOR --directory .accp-local/production` 是显式维护命令：要求专用 ACCP 数据库、没有其他连接、没有同名新角色，在单事务中将 public 更名为 accp、转移所有权并建立分权角色，不删除业务数据。失败回滚且隐藏可能包含密码的 SQL 输出。该迁移辅助脚本仍需部署方在自身旧版本备份上演练。

随后用 Compose override 将 `postgres-data` 指向已核对的现有 external 卷，停止旧 PostgreSQL 容器后才允许新容器挂载同一卷；运行 migrate、grants，跳过 bootstrap，重建服务并检查 doctor、原用户/任务/成果/审计数量。保留旧签名 key 到限时 legacy 窗口，以免无意使已有 Session 失效。确认新运维连接后再处理旧统一超级用户账号，不能在确认前禁用最后一个可用维护入口。

## 隔离 Keycloak 验收

验收环境使用假的 example.test 用户和随机密码，无企业外部权限。`deploy/acceptance/compose.yaml` 叠加生产 Compose，Keycloak 的 start-dev 仅用于此隔离环境。fixture 的临时 CA 只加入测试容器信任，不安装到宿主系统。

```sh
node scripts/production-env.mjs --directory .accp-local/product-deploy \
  --public-url https://accp.localhost:18443 --issuer https://idp.localhost:18443/realms/accp \
  --client-id accp-web --audience accp-api --admin-subject 00000000-0000-0000-0000-000000000001 \
  --repository https://github.com/example/orders
node scripts/oidc-fixture.mjs .accp-local/product-deploy
go run scripts/oidc-cert.go .accp-local/product-deploy/tls
docker build -t accp:product-d01-d03 .
docker compose -p accp-product --env-file .accp-local/product-deploy/compose.env -f deploy/production/compose.yaml -f deploy/acceptance/compose.yaml up -d
docker compose -p accp-product --env-file .accp-local/product-deploy/compose.env -f deploy/production/compose.yaml -f deploy/acceptance/compose.yaml --profile tools run --rm bootstrap
docker compose -p accp-product --env-file .accp-local/product-deploy/compose.env -f deploy/production/compose.yaml -f deploy/acceptance/compose.yaml --profile tools run --rm doctor
docker compose -p accp-product --env-file .accp-local/product-deploy/compose.env -f deploy/production/compose.yaml -f deploy/acceptance/compose.yaml --profile tests run --build --rm browser
```

浏览器仅挂载测试账号文件及公开 CA，关闭 trace/screenshot，避免记录 token。测试必须用全新隔离数据库或明确清理后的 fixture 重跑，不向已有业务环境执行。验收结果与尚未执行项记录在 [产品计划](product-delivery-plan.md)。

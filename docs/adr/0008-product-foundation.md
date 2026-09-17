# 0008：企业持续管理、API 身份与单机生产基线

状态：接受。日期：2026-09-16。对应产品计划 D01–D03；补充 0004、0006。

## 背景

空库 bootstrap 不能满足持续运营。Web 登录客户端与 API 资源服务器也不能共用含糊的 token 契约。本轮保持单企业、多项目部署，不增加组织管理员、SaaS 租户或多端联合验收。

## 决策

任一项目的有效 ADMIN 可以登记本企业人类身份、创建项目及查看企业管理审计。创建者自动成为新项目 ADMIN。成员登记绑定配置的 issuer 和唯一 subject，不自动授予项目权限。项目成员、角色、仓库与项目状态修改仍要求目标项目 ADMIN；Agent 不获得这些入口。项目 ADMIN 只停用其管理的项目成员。全局停用使用本机 `human-status` 运维命令，记录有效管理员 actor 和原因；不是远程组织管理 API。

项目有 ACTIVE/ARCHIVED 状态和版本。归档与执行写入共用项目行锁；所有任务须为 DONE/CANCELED，且不存在 RUNNING Run 或 AWAITING_APPROVAL/READY/RUNNING/UNKNOWN 工具调用。归档拒绝后续项目写入并撤销已有 Session。恢复不复活旧 Session。成员停用同样撤销其对应授权，最后一个有效 ADMIN 不可移除。管理写入沿用幂等键、原因与审计，修改项目使用 If-Match；企业级写入有独立幂等和不可变审计表。

生产采用 Authorization Code + PKCE S256。SPA client ID 与 API audience 分开配置且必须不同。API 只接受 RS256 签名、issuer/audience/expiry/subject 正确的 JWT access token，并要求受签名保护的 `typ=Bearer` payload（Keycloak）或 `typ=at+jwt` JOSE header。不接受 ID token、opaque token，也不从 IdP claims 自动创建用户或赋予项目角色。其他 IdP 接入需提供兼容 access-token 标识或另立契约。

Web token 仅驻留内存；sessionStorage 只保存短期 OIDC 回调状态。过期后清除登录并重新认证，不进行后台 refresh。注销清除本地状态并调用 IdP end-session；已经签发的 access token 不因浏览器注销立即失效，其剩余有效期由 IdP 控制。ACCP 每次请求读取人类和成员状态，离岗须同步停用 ACCP 成员；IdP 单方面撤销的即时回调不在本次范围。

生产基线为单机 Compose：Caddy TLS、PostgreSQL、JetStream、一个 API 和一个 Worker。迁移、bootstrap、API、Worker 使用独立数据库登录，运行账号不得拥有 schema 或迁移表写权限。Secret 通过只读文件注入；Session 签名支持 active kid 和最多八把验证密钥，保留旧 key 的窗口由运维明确控制。数据库、NATS 和 Caddy 使用持久卷；进程故障自动重启。`doctor` 汇总安装检查，Worker 就绪必须同时具有近期事件循环与治理循环进展。

## 代价与边界

项目 ADMIN 的企业登记权限是本产品明确选择，意味着管理员可看到企业成员目录及企业管理审计；不因此获得其他项目业务权限。需要独立 IAM 管理员时应新增角色设计。

单机进程恢复不等于高可用或完整备份恢复证明。D04–D10 继续独立验收。TLS 证书、真实企业 IdP 注册和正式发行镜像仍由部署方提供；隔离 Keycloak 验证不能替代目标企业的接入验收。

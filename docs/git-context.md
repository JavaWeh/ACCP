# Git Context 来源与候选发布

项目 MEMBER 在共享上下文页选择已登记的 GitHub 仓库、相对文件路径和 ref。服务端从仓库记录派生 URL，不接收任意外部地址；不执行仓库代码，也不把正文当作权限指令。登记源后使用“读取来源和当前版本”“同步为候选版本”，保留所见 Context 版本作为 If-Match。冲突需重新读取，网络未知结果使用原幂等键恢复。

Provider 先解析 ref 的 commit SHA 和根目录树，再按不可变 tree/blob SHA 读取普通文件。拒绝符号链接、子模块、截断目录树、无效 UTF-8、NUL、超过 256 KiB 的正文以及 blob SHA 与内容不匹配。Git SHA-1 用于对象标识；存储证据使用 SHA-256 摘要。接口依据 GitHub 官方 [Commits](https://docs.github.com/en/rest/commits/commits)、[Trees](https://docs.github.com/en/rest/git/trees)、[Blobs](https://docs.github.com/en/rest/git/blobs) 协议。

新正文生成 CANDIDATE，记录仓库 ID/URL、路径、ref、commit、blob 和内容摘要。相同 Context 的同内容复用已有版本，保留首次创建时的来源证据；每次新同步仍重新访问 Provider 验证读取权限。原幂等请求重试返回首次结果，不重复外部读取。Git 来源不允许通过普通正文上传接口创建版本。

Web 可对照当前发布版本与候选正文，分页查看仍引用其他版本的未归档任务。REVIEWER 或 ADMIN 使用现有发布入口人工发布，Owner 再通过任务输入变更明确选用新版本。发布不修改现有任务引用、历史 Run 或活跃 ContextSnapshot。访问始终检查当前项目成员与角色；Agent 不获得来源登记或同步权限。

新增迁移 008 只添加来源和版本证据表，不改历史迁移。来源及版本来源账本禁止更新/删除。API 仅新增 INSERT 权限，Worker 无写来源权限。

接口包括 POST 项目 git-contexts、POST Context source-sync、GET source、GET 版本 diff（可指定同一 Context 的 base）与 impact。写入沿用 Idempotency-Key；同步要求 Context If-Match；发布要求候选版本 If-Match。差异正文最多各 256 KiB，影响列表上限 100 条。

验证状态：Provider 正反例和隔离数据库 Linux race（4.508 秒）已通过，覆盖 mutable ref、内容去重、权限撤销、伪造正文、跨项目拒绝、差异基线、影响查询与活跃快照不变。全量 Linux race 通过（controlplane 248.740 秒），Go vet 通过。79 正例、32 反例、462 OpenAPI Schema 位置、10 工具测试及 18 项 Web 浏览器回归通过。008 隔离升级及 11 项 doctor 通过。

本机真实 GitHub/OIDC 首次场景受共享出口匿名 API 限额拒绝（HTTP 403，剩余 0），该次保留为失败记录。随后 [PR #14 官方容器验收](https://github.com/JavaWeh/ACCP/actions/runs/35182699031) 中同一脚本真实执行通过：1 passed（2.9s），Git 外部读取 629 ms；commit `e42dc8532301705bf238b715f8bf3c0cbf41f11e`、blob `8f3e6ad3c70a4e1a9b1050c52bcea90f901291bc`，重复同步去重、差异查看和人工发布均成功。浏览器仅挂载随机隔离账号、公开 CA 与公共测试文件，没有 Provider 密钥。

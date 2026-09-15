# 开发与交付工作流

## 需求到验收

1. 人类创建 Issue，填写 Owner、目标、范围、Context 版本、依赖和验收条件。
2. 有架构取舍时先补 ADR；有公共接口变化时同步 OpenAPI、Schema 与正反例。
3. 在 `dev/<topic>`（或任务明确指定的分支） 分支工作，记录 Agent 只是执行工具，不能代替责任人。
4. 提交成果和验证证据，创建 PR；人类审核行为、权限、兼容性与范围。
5. 检查通过且人类接受后合并，记录任务和成果关系。

这是研发流程约定，不表示 GitHub 已配置强制分支保护。首次基线经维护者授权直接提交 main；后续分支保护由维护者根据团队权限配置。

## 公共资料布局

```text
README.md                    项目入口与阶段状态
CONTRIBUTING.md               人类责任与贡献要求
docs/                        领域、架构、流程、治理与 ADR
contracts/openapi.yaml       REST 草案
contracts/schemas/           领域、事件与 Adapter Schema
contracts/examples/          正例与预期拒绝的反例
scripts/                     文档/契约/私有文件校验工具及测试
cmd/accp/                    Go 服务与操作者命令入口
internal/                    身份、Task/Context、执行、Bridge 和事件 Worker
pkg/client/                  厂商无关 Go 协作 SDK
cmd/accp-bridge/              MCP stdio / CLI Bridge
compose.yaml                 本地开发环境
.github/                     Issue、PR 模板与 CI
```

根目录 Node 工具链用于验证和本地配置生成，`web/` 是独立锁定依赖的 React 应用；Go 负责控制面、Bridge 和 Worker。M1–M3 后端与 M4 Web 产品功能均已实现。基础身份见 [M1 控制面](m1-control-plane.md)，执行、升级与验收见 [M2 异构执行](m2-execution.md)。

## 本地验证

```sh
npm ci --ignore-scripts
npm run check
git diff --check
```

`check` 包含 Markdown、仓库内链接及锚点、OpenAPI、JSON Schema 和正反例、验证工具测试与私有路径检查。外部链接不在普通 CI 中发起网络请求，以免不稳定站点影响离线可重复验证；引用规范版本须在更新时人工核对。

OpenAPI 校验还编译所有被引用的请求/响应 schema。额外一致性检查确保正例覆盖每个事件和核心模型、反例确实因指定约束失败。M1 的运行时测试使用真实 PostgreSQL；Go CI 同时进行 race 检测、vet、编译与 Docker 构建。

工具依赖与 Action 均锁定版本。Markdown 校验器的 `smol-toml` 传递依赖显式覆盖到 1.8.0，以避开上游固定旧版本的已知拒绝服务漏洞；更新工具链时重新运行依赖审计和全部校验，不盲目执行带破坏性升级的自动修复。

## 私有文件禁入

skills、个人 Agent 配置、GitNexus 数据、环境变量文件、私钥与本地运行数据不进入 Git。忽略规则只能避免普通暂存，不能保护被 `git add -f` 强制加入的内容，因此检查器读取真实 Git 索引与历史。

提交前：检查明确暂存清单，运行 `npm run check:private`。提交后、推送前：运行 `npm run check:history`，检查 HEAD 全部可达提交树，包含后来被删除的私有文件。禁止仅检查最终状态后就上传历史。

```sh
git diff --cached --name-only
npm run check:private
git diff --cached --check
# 审核明确暂存的公共文件后提交
git commit -m "docs: describe the concrete change"
npm run check:history
git push origin HEAD
```

CI 以只读权限运行并拉取完整历史，不上传工作区压缩包，也不需要个人 skills。检查器不替代全面秘密扫描：未知文件名中的任意密钥无法仅凭路径识别，提交者仍须核验内容。

## 可选本地代码索引

配置了 GitNexus 的贡献者在修改已有符号前做 impact，报告直接调用方、影响流程与风险；提交前做 detect_changes。索引为空或符号未找到时，报告未知并通过文件检查与测试补充，不能据此声称零风险。

公共 CI 不依赖个人索引服务；本地索引和 Agent 配置不提交。Go 模块变化后刷新本地索引，再检查实际影响范围。

## 推送与核对

保留现有 LICENSE 和历史，不强制推送。若远程前进，先整合变更并重跑检查；推送后核对远程 SHA、文件树和 Actions 结果。最终报告应明确哪些检查实际通过，不能把已创建工作流等同于工作流已运行成功。

## Web 验证

```sh
npm --prefix web ci --ignore-scripts
npm --prefix web run build
cd web
npx playwright install chromium
npm test
```

浏览器测试需运行独立的开发部署，设置 `ACCP_WEB_URL` 和 `ACCP_WEB_CREDENTIALS_FILE`；默认使用本机隔离测试环境。测试会创建真实 Context 和 Task，禁止指向生产环境。凭证、截图及测试结果目录不提交，不上传含授权信息的浏览器 trace。CI 使用一次性数据库与开发凭证完成这些操作。

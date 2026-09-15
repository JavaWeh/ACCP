import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { API, label, stamp } from "./api";
import type { Doc, Membership } from "./api";
import { Badge, Empty, Field, Form, Message, text } from "./ui";
import { Tasks } from "./tasks";
import {
  Contexts,
  Artifacts,
  Approvals,
  Agents,
  Members,
  Audit,
  Tools,
} from "./workspace";
import "./style.css";

export type Workspace = {
  api: API;
  project: Doc;
  me: Doc;
  members: Membership[];
  tasks: Doc[];
  contexts: Doc[];
  artifacts: Doc[];
  approvals: Doc[];
  tools: Doc[];
  roles: string[];
  refresh: () => Promise<void>;
};
type AuthConfig = {
  mode: string;
  issuer: string;
  client_id: string;
  public_url: string;
};
const nav = [
  { id: "overview", icon: "◈", title: "工作概览" },
  { id: "tasks", icon: "▤", title: "任务协作" },
  { id: "contexts", icon: "▧", title: "共享上下文" },
  { id: "artifacts", icon: "◇", title: "交付成果" },
  { id: "approvals", icon: "✓", title: "审批中心" },
  { id: "agents", icon: "⌘", title: "执行代理" },
  { id: "tools", icon: "⚙", title: "工具网关" },
  { id: "members", icon: "⊙", title: "项目成员" },
  { id: "audit", icon: "↗", title: "审计记录" },
];

function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [token, setToken] = useState("");
  const [authError, setAuthError] = useState<unknown>();
  const [page, setPage] = useState("overview");
  const [me, setMe] = useState<Doc>();
  const [projects, setProjects] = useState<Doc[]>([]);
  const [projectID, setProjectID] = useState("");
  const [data, setData] = useState<{
    members: Membership[];
    tasks: Doc[];
    contexts: Doc[];
    artifacts: Doc[];
    approvals: Doc[];
    tools: Doc[];
  }>({
    members: [],
    tasks: [],
    contexts: [],
    artifacts: [],
    approvals: [],
    tools: [],
  });
  const [error, setError] = useState<unknown>();
  const [loaded, setLoaded] = useState(false);
  const [updated, setUpdated] = useState("");
  const api = useMemo(
    () =>
      new API(token, () => {
        setToken("");
        setMe(undefined);
        setAuthError(new Error("登录已过期，请重新登录。"));
      }),
    [token],
  );
  const manager = useMemo(
    () =>
      config?.mode === "oidc"
        ? new UserManager({
            authority: config.issuer,
            client_id: config.client_id,
            redirect_uri: `${config.public_url}/auth/callback`,
            post_logout_redirect_uri: config.public_url,
            response_type: "code",
            scope: "openid profile",
            automaticSilentRenew: false,
            userStore: new WebStorageStateStore({
              store: window.sessionStorage,
            }),
          })
        : undefined,
    [config],
  );
  useEffect(() => {
    fetch("/api/v1/auth/config")
      .then((r) => {
        if (!r.ok) throw new Error("登录服务暂不可用");
        return r.json();
      })
      .then(setConfig)
      .catch(setAuthError);
  }, []);
  useEffect(() => {
    if (!manager) return;
    let active = true;
    (async () => {
      try {
        const user =
          location.pathname === "/auth/callback"
            ? await manager.signinRedirectCallback()
            : await manager.getUser();
        if (active && user && !user.expired && user.id_token) {
          setToken(user.id_token);
          history.replaceState(null, "", "/");
        }
      } catch (e) {
        if (active) setAuthError(e);
      }
    })();
    return () => {
      active = false;
    };
  }, [manager]);
  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([api.call("/me"), api.all("/projects")])
      .then(([human, list]) => {
        if (active) {
          setMe(human);
          setProjects(list);
          setProjectID(list[0]?.id || "");
        }
      })
      .catch((e) => {
        if (active) setAuthError(e);
      });
    return () => {
      active = false;
    };
  }, [api, token]);
  const refreshGeneration = useRef(0);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    if (!projectID || !me) return;
    const prefix = `/projects/${projectID}`;
    const members = await api.all<Membership>(`${prefix}/members`);
    const roles: string[] = members.find((m) => m.id === me.id)?.roles || [];
    const reviewer = roles.includes("REVIEWER") || roles.includes("ADMIN");
    const [tasks, contexts, artifacts, approvals, tools] = await Promise.all([
      api.all(`${prefix}/tasks`),
      api.all(`${prefix}/contexts`),
      api.all(`${prefix}/artifacts`),
      reviewer ? api.all(`${prefix}/approvals`) : Promise.resolve([]),
      api.all(`${prefix}/tools`),
    ]);
    if (generation !== refreshGeneration.current) return;
    setData({ members, tasks, contexts, artifacts, approvals, tools });
    setError(undefined);
    setLoaded(true);
    setUpdated(new Date().toISOString());
  }, [projectID, me, api]);
  useEffect(() => {
    setLoaded(false);
    refresh().catch(setError);
    const timer = setInterval(() => refresh().catch(setError), 10000);
    return () => {
      ++refreshGeneration.current;
      clearInterval(timer);
    };
  }, [refresh]);
  async function logout() {
    ++refreshGeneration.current;
    setToken("");
    setMe(undefined);
    setLoaded(false);
    setData({
      members: [],
      tasks: [],
      contexts: [],
      artifacts: [],
      approvals: [],
      tools: [],
    });
    if (manager) await manager.removeUser();
  }
  if (!token || !me)
    return (
      <main className="login">
        <div className="login-story">
          <div className="brand">
            <span className="brand-mark">A</span> ACCP
          </div>
          <div>
            <p className="eyebrow">AGENT COLLABORATION CONTROL PLANE</p>
            <h1>
              让人负责，
              <br />
              让协作有据可循。
            </h1>
            <p>
              任务、上下文与成果，汇聚到同一个工作空间。
              <br />
              连接你的团队与 AI 执行代理。
            </p>
            <div className="login-diagram">
              <span>人类 Owner</span>
              <i>→</i>
              <span>Agent 执行</span>
              <i>→</i>
              <span>成果验收</span>
            </div>
          </div>
          <small>Human · Context · Evidence</small>
        </div>
        <section className="login-card">
          <p className="eyebrow">WELCOME TO ACCP</p>
          <h2>进入协作工作空间</h2>
          <p className="muted">使用你的企业身份访问授权项目。</p>
          {authError !== undefined && <Message error={authError} />}{" "}
          {!config ? (
            <p>正在连接登录服务…</p>
          ) : config.mode === "development" ? (
            <Form
              submit="登录工作空间"
              action={async (data) => {
                const value = text(data, "token");
                const probe = new API(value, () => {});
                await probe.call("/me");
                setAuthError(undefined);
                setToken(value);
              }}
            >
              <div className="notice">
                本地开发环境 · 使用管理员提供的个人开发凭证。
              </div>
              <Field label="个人开发凭证">
                <input
                  name="token"
                  type="password"
                  autoComplete="off"
                  required
                  placeholder="输入个人访问凭证"
                />
              </Field>
            </Form>
          ) : (
            <button
              className="primary wide"
              onClick={() => manager?.signinRedirect().catch(setAuthError)}
            >
              使用企业账号登录 →
            </button>
          )}
          <small className="login-footer">
            每次执行都有明确的人类责任主体。
          </small>
        </section>
      </main>
    );
  const project = projects.find((p) => p.id === projectID);
  const roles: string[] = data.members.find((m) => m.id === me.id)?.roles || [];
  const workspace = project
    ? { api, project, me, ...data, roles, refresh }
    : undefined;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">A</span> ACCP{" "}
          <span className="edition">WORKSPACE</span>
        </a>
        <div className="project-select">
          <small>当前项目</small>
          <select
            aria-label="当前项目"
            value={projectID}
            onChange={(e) => setProjectID(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => setPage(item.id)}
            >
              <span>{item.icon}</span>
              {item.title}
              {item.id === "approvals" &&
                data.approvals.some((a) => a.status === "PENDING") && (
                  <i className="nav-count">
                    {
                      data.approvals.filter((a) => a.status === "PENDING")
                        .length
                    }
                  </i>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" /> 私有协作空间
          <small>协议驱动 · 人类治理</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            {project?.name || "工作空间"} <span>/</span>{" "}
            {nav.find((n) => n.id === page)?.title}
          </div>
          <div className="identity">
            <span className="avatar">
              {String(me.display_name || me.id).slice(0, 1)}
            </span>
            <span>
              {me.display_name || me.id}
              <small>{roles.map(label).join(" / ")}</small>
            </span>
            <button className="text-button" onClick={logout}>
              退出
            </button>
          </div>
        </header>
        <main className="workspace">
          <div className="page-heading">
            <div>
              <p className="eyebrow">
                {page === "overview"
                  ? "TEAM COLLABORATION"
                  : "PROJECT WORKSPACE"}
              </p>
              <h1>{nav.find((n) => n.id === page)?.title}</h1>
            </div>
            <div className="sync">
              <span className="status-dot" />
              {updated
                ? `更新于 ${new Date(updated).toLocaleTimeString("zh-CN", { hour12: false })}`
                : "正在同步"}
              <button
                className="text-button"
                onClick={() => refresh().catch(setError)}
              >
                刷新
              </button>
            </div>
          </div>
          {error !== undefined && <Message error={error} />}{" "}
          {!projects.length ? (
            <Empty title="尚无可访问项目">请联系管理员配置项目成员关系。</Empty>
          ) : !loaded ? (
            <div className="loading">正在读取项目数据…</div>
          ) : (
            workspace && (
              <>
                {page === "overview" && (
                  <Overview w={workspace} navigate={setPage} />
                )}{" "}
                {page === "tasks" && <Tasks w={workspace} />}{" "}
                {page === "contexts" && <Contexts w={workspace} />}{" "}
                {page === "artifacts" && <Artifacts w={workspace} />}{" "}
                {page === "approvals" && <Approvals w={workspace} />}{" "}
                {page === "agents" && <Agents w={workspace} />}{" "}
                {page === "members" && <Members w={workspace} />}{" "}
                {page === "audit" && <Audit w={workspace} />}{" "}
                {page === "tools" && <Tools w={workspace} />}
              </>
            )
          )}
        </main>
        <footer className="page-footer">
          ACCP · 每一次交付，都有上下文与责任记录。
        </footer>
      </div>
    </div>
  );
}
function Overview({
  w,
  navigate,
}: {
  w: Workspace;
  navigate: (page: string) => void;
}) {
  const counts = [
    {
      title: "项目任务",
      value: w.tasks.length,
      detail: "当前项目所有任务",
      page: "tasks",
    },
    {
      title: "正在执行",
      value: w.tasks.filter((t) => t.status === "RUNNING").length,
      detail: "Agent 正在执行的任务",
      page: "tasks",
    },
    {
      title: "等待验收",
      value: w.tasks.filter((t) => t.status === "IN_REVIEW").length,
      detail: "需要 Owner 确认成果",
      page: "tasks",
    },
    {
      title: "待审批操作",
      value: w.approvals.filter((t) => t.status === "PENDING").length,
      detail: "等待独立人类审核",
      page: "approvals",
    },
  ];
  const recent = [...w.tasks]
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 6);
  return (
    <>
      <section className="welcome">
        <div>
          <span className="badge badge-ACTIVE">团队工作空间</span>
          <h2>把目标变成可追溯的交付。</h2>
          <p>明确任务负责人，固定执行上下文，用成果和人工审核推进协作。</p>
          <button className="primary" onClick={() => navigate("tasks")}>
            进入任务协作 <span>↗</span>
          </button>
        </div>
        <div className="collaboration-graphic" aria-hidden="true">
          <div className="graphic-center">
            A<span>ACCP</span>
          </div>
          <div className="graphic-node node-owner">
            ◎<span>Human Owner</span>
          </div>
          <div className="graphic-node node-context">
            ▧<span>Context</span>
          </div>
          <div className="graphic-node node-agent">
            ⌘<span>Agent</span>
          </div>
          <div className="graphic-node node-artifact">
            ◇<span>Artifact</span>
          </div>
        </div>
      </section>
      <div className="metrics">
        {counts.map((c) => (
          <button
            className="metric"
            key={c.title}
            onClick={() => navigate(c.page)}
          >
            <span>
              {c.title}
              <i>↗</i>
            </span>
            <strong>{c.value.toString().padStart(2, "0")}</strong>
            <small>{c.detail}</small>
          </button>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="section-title">
            <h2>近期任务</h2>
            <button className="text-button" onClick={() => navigate("tasks")}>
              查看全部 →
            </button>
          </div>
          {!recent.length ? (
            <Empty title="从第一项任务开始">
              创建目标、指定负责人并选择执行依据。
            </Empty>
          ) : (
            <div className="task-table">
              {recent.map((task) => (
                <button key={task.id} onClick={() => navigate("tasks")}>
                  <span className="task-glyph">▤</span>
                  <span>
                    <strong>{task.title}</strong>
                    <small>
                      {w.members.find((m) => m.id === task.owner_user_id)
                        ?.display_name || task.owner_user_id}{" "}
                      · {stamp(task.updated_at)}
                    </small>
                  </span>
                  <Badge value={task.status} />
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="panel foundation">
          <div className="section-title">
            <h2>协作基础</h2>
          </div>
          <div>
            <span>▧</span>
            <p>
              <strong>{w.contexts.length} 项共享上下文</strong>
              <small>版本明确，执行输入可追溯</small>
            </p>
          </div>
          <div>
            <span>◇</span>
            <p>
              <strong>{w.artifacts.length} 份交付成果</strong>
              <small>保留来源、核验与审核记录</small>
            </p>
          </div>
          <div>
            <span>⊙</span>
            <p>
              <strong>
                {w.members.filter((m) => m.active).length} 名项目成员
              </strong>
              <small>每项任务都有明确的人类 Owner</small>
            </p>
          </div>
          <p className="foundation-note">
            Agent 提交完成候选后，仍由人类负责人决定是否接受。
          </p>
        </section>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

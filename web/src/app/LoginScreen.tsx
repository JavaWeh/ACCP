import { useI18n, LanguageSwitcher } from "../i18n";
import { Icon } from "../icons";
import { Card } from "@heroui/react";
import type { UserManager } from "oidc-client-ts";
import { API } from "../api";
import { Button, Input, Field, Form, Message, text } from "../ui";
import { buildReturnTo, sanitizeReturnTo } from "../returnTo";
import type { AuthConfig } from "./types";

export function LoginScreen({
  config,
  authError,
  manager,
  restoreReturnTo,
  setToken,
  setAuthError,
}: {
  config: AuthConfig | undefined;
  authError: unknown;
  manager: UserManager | undefined;
  restoreReturnTo: (raw: unknown) => void;
  setToken: (token: string) => void;
  setAuthError: (error: unknown) => void;
}) {
  const { translate } = useI18n();

  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-2">
      <section className="relative hidden min-h-screen flex-col justify-between overflow-hidden bg-slate-950 p-12 text-white lg:flex xl:p-20">
        <div
          className="pointer-events-none absolute -right-36 top-20 size-[600px] rounded-full bg-indigo-600/25 blur-[100px]"
          aria-hidden="true"
        />
        <div className="relative flex items-center gap-3 text-xl font-semibold">
          <img src="/brand/accp-logo-mark.svg" alt="" className="size-12" />{" "}
          ACCP{" "}
          <span className="ml-2 text-xs font-normal text-slate-400">
            {translate("Workspace")}
          </span>
        </div>
        <div className="relative max-w-lg">
          <p className="mb-6 text-xs font-semibold tracking-[0.2em] text-indigo-300">
            {translate("BUILT FOR COLLABORATION")}
          </p>
          <h1 className="text-5xl font-semibold leading-[1.3] tracking-tight xl:text-6xl">
            {translate("让人负责，")}
            <br />
            <span className="text-indigo-300">
              {translate("让协作有据可循。")}
            </span>
          </h1>
          <p className="mt-7 max-w-md text-base leading-8 text-slate-300">
            {translate(
              "把团队、AI 执行代理和交付证据连接起来。每项任务有明确的负责人，每一次交付都可追溯。",
            )}
          </p>
          <div className="mt-12 grid grid-cols-3 gap-3">
            {[
              ["members", translate("人类治理")],
              ["agents", translate("Agent 执行")],
              ["artifacts", translate("成果验收")],
            ].map(([icon, title], i) => (
              <div
                key={icon}
                className="rounded-xl border border-white/15 bg-white/5 p-4"
              >
                <Icon name={icon} className="mb-5 text-indigo-300" />
                <p className="text-xs text-slate-400">0{i + 1}</p>
                <p className="mt-1 text-sm font-medium">{title}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-slate-400">
          ACCP / AGENT COLLABORATION CONTROL PLANE
        </p>
      </section>
      <Card className="login-card m-auto w-full max-w-lg border-0 bg-transparent p-7 shadow-none sm:p-12">
        <div className="mb-6 flex justify-end">
          <LanguageSwitcher />
        </div>
        <img
          src="/brand/accp-logo-mark.svg"
          alt="ACCP"
          className="mb-7 size-16"
        />
        <p className="mb-3 text-xs font-semibold tracking-widest text-indigo-700">
          {translate("欢迎回来")}
        </p>
        <h2 className="text-3xl font-semibold tracking-tight">
          {translate("进入协作工作空间")}
        </h2>
        <p className="mb-8 mt-3 text-sm text-slate-600">
          {translate("使用你的企业身份访问授权项目。")}
        </p>
        {authError !== undefined && <Message error={authError} />}{" "}
        {!config ? (
          <p>{translate("正在连接登录服务…")}</p>
        ) : config.mode === "development" &&
          location.pathname === "/dev-login" ? (
          <Form
            submit={translate("登录工作空间")}
            action={async (data) => {
              const value = text(data, "token");
              const probe = new API(value, () => {});
              await probe.call("/me");
              setAuthError(undefined);
              const returnTo = new URLSearchParams(location.search).get(
                "returnTo",
              );
              restoreReturnTo(returnTo ?? sanitizeReturnTo(buildReturnTo()));
              setToken(value);
            }}
          >
            <div className="notice">
              {translate("本地开发环境 · 使用管理员提供的个人开发凭证。")}
            </div>
            <Field label={translate("个人开发凭证")}>
              <Input
                name="token"
                type="password"
                autoComplete="off"
                required
                placeholder={translate("输入个人访问凭证")}
              />
            </Field>
          </Form>
        ) : config.mode === "development" ? (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">
            <p>{translate("此环境使用本地开发认证。")}</p>
            <a
              className="mt-3 inline-block font-medium"
              href={`/dev-login?returnTo=${encodeURIComponent(buildReturnTo())}`}
            >
              {translate("前往开发登录 →")}
            </a>
          </div>
        ) : (
          <Button
            variant="primary"
            className="w-full"
            onClick={() =>
              manager
                ?.signinRedirect({
                  state: { returnTo: buildReturnTo() },
                })
                .catch(setAuthError)
            }
          >
            {translate("使用企业账号登录 →")}
          </Button>
        )}
        <small className="mt-8 block border-t border-slate-200 pt-6 text-xs leading-6 text-slate-600">
          {translate("每次执行都有明确的人类责任主体。")}
        </small>
      </Card>
    </main>
  );
}

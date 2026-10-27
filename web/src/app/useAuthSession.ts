import { LocalizedError } from "../i18n";
import { useEffect, useMemo, useState } from "react";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { API } from "../api";
import type { Doc } from "../api";
import { readRoute, type Route } from "../routing";
import { sanitizeReturnTo } from "../returnTo";
import type { AuthConfig } from "./types";

export function useAuthSession({
  setRoute,
}: {
  setRoute: (route: Route) => void;
}) {
  const [config, setConfig] = useState<AuthConfig>();
  const [token, setToken] = useState("");
  const [authError, setAuthError] = useState<unknown>();
  const [me, setMe] = useState<Doc>();
  const api = useMemo(
    () =>
      new API(token, () => {
        setToken("");
        setMe(undefined);
        setAuthError(new LocalizedError("登录已过期，请重新登录。"));
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
            disablePKCE: false,
            stateStore: new WebStorageStateStore({
              store: window.sessionStorage,
            }),
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
        if (!r.ok) throw new LocalizedError("登录服务暂不可用");
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
        if (active && user && !user.expired && user.access_token) {
          setToken(user.access_token);
          if (location.pathname === "/auth/callback") {
            const returnTo = (user.state as { returnTo?: unknown } | null)
              ?.returnTo;
            const safePath = sanitizeReturnTo(returnTo);
            history.replaceState(null, "", safePath);
            setRoute(readRoute(location.pathname));
          }
        }
        await manager.clearStaleState();
      } catch (e) {
        if (active) setAuthError(e);
      }
    })();
    return () => {
      active = false;
    };
  }, [manager, setRoute]);
  useEffect(() => {
    if (!manager) return;
    const expired = () => {
      setToken("");
      setMe(undefined);
      setAuthError(new LocalizedError("登录已过期，请重新登录。"));
      void manager.removeUser();
    };
    manager.events.addAccessTokenExpired(expired);
    return () => manager.events.removeAccessTokenExpired(expired);
  }, [manager]);

  return {
    config,
    token,
    setToken,
    authError,
    setAuthError,
    me,
    setMe,
    api,
    manager,
  };
}

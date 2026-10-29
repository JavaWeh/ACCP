import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Button } from "../ui";
import type { MessageKey } from "../locales/zh-CN";
import type { ConnectionState } from "./useEventStream";

type StatusMeta = {
  icon: string;
  dot: string;
  labelKey: MessageKey;
  ariaKey: MessageKey;
};

const META: Record<ConnectionState, StatusMeta> = {
  live: {
    icon: "signal",
    dot: "bg-emerald-500",
    labelKey: "实时",
    ariaKey: "实时连接：实时",
  },
  reconnecting: {
    icon: "reconnect",
    dot: "bg-amber-500",
    labelKey: "正在重新连接…",
    ariaKey: "实时连接：正在重新连接",
  },
  polling: {
    icon: "clock",
    dot: "bg-slate-400",
    labelKey: "定时刷新",
    ariaKey: "实时连接：定时刷新",
  },
  auth_expired: {
    icon: "alert",
    dot: "bg-rose-500",
    labelKey: "需重新登录",
    ariaKey: "实时连接：需要重新登录",
  },
};

/**
 * Whole-console connection indicator (F1). Never relies on colour alone: a
 * distinct icon plus text label accompany every state, the accessible name
 * tracks the state, and motion is disabled under prefers-reduced-motion.
 */
export function ConnectionStatus({
  status,
  lastUpdated,
  onReauthenticate,
}: {
  status: ConnectionState;
  lastUpdated?: string;
  onReauthenticate: () => void;
}) {
  const { translate, time } = useI18n();
  const meta = META[status];
  const spinning = status === "reconnecting";
  const dotMotion = spinning ? "animate-pulse motion-reduce:animate-none" : "";
  const iconMotion = spinning ? "animate-spin motion-reduce:animate-none" : "";
  return (
    <details className="relative shrink-0">
      <summary
        aria-label={translate(meta.ariaKey)}
        className="flex min-h-8 cursor-pointer list-none items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1 text-sm text-slate-700 outline-offset-2 select-none hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-600 [&::-webkit-details-marker]:hidden"
      >
        <span
          className={`inline-block size-2 shrink-0 rounded-full ${meta.dot} ${dotMotion}`}
          aria-hidden="true"
        />
        <Icon name={meta.icon} className={`size-4 ${iconMotion}`} />
        <span className="hidden sm:inline">{translate(meta.labelKey)}</span>
      </summary>
      <span className="sr-only" role="status">
        {translate(meta.ariaKey)}
      </span>
      <div className="absolute right-0 z-40 mt-2 w-72 space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-lg">
        {status === "live" && <p>{translate("已连接实时更新")}</p>}
        {status === "reconnecting" && (
          <>
            <p>{translate("正在重新连接实时通道…")}</p>
            <p className="text-xs text-slate-500">
              {translate("数据将通过定时刷新保持同步。")}
            </p>
          </>
        )}
        {status === "polling" && (
          <p>{translate("实时不可用，已改用定时刷新（每 10 秒）。")}</p>
        )}
        {status === "auth_expired" && (
          <>
            <p>{translate("登录已过期。请重新登录以继续接收更新。")}</p>
            <Button variant="primary" size="sm" onPress={onReauthenticate}>
              {translate("重新登录")}
            </Button>
          </>
        )}
        {lastUpdated && (
          <p className="text-xs text-slate-500">
            {translate("上次更新：{time}", { time: time(lastUpdated) })}
          </p>
        )}
      </div>
    </details>
  );
}

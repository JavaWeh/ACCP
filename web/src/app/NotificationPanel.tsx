import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { Button, Empty, Message } from "../ui";
import type { MessageKey } from "../locales/zh-CN";
import type { NotificationItem, useNotifications } from "./useNotifications";

/** Notification type → its localized one-line label (US-20 taxonomy). */
export const NOTIFICATION_LABELS: Record<string, MessageKey> = {
  TASK_ASSIGNED: "任务已指派给你",
  REVIEW_REQUIRED: "任务待你评审",
  APPROVAL_PENDING: "审批待处理",
  TASK_BLOCKED: "任务已阻塞",
  COMMENT_MENTION: "评论中提到了你",
};

/** Resolve a notification type to a message key, falling back to the neutral
 * "通知" heading for a type the console does not yet know. */
export function notificationLabelKey(type: string): MessageKey {
  return NOTIFICATION_LABELS[type] ?? "通知";
}

type Notifications = ReturnType<typeof useNotifications>;

/**
 * Notification-centre panel (F3). A desktop popover (O-W17, capped height with
 * its own scroll) that goes full-width under `sm`. A filter pair switches
 * between all and unread; "全部标为已读" clears the badge (O-W9). A row click
 * marks that one read and deep-links to its subject. The empty state points at
 * My Work so the two cross-project surfaces stay linked without merging.
 */
export function NotificationPanel({
  notif,
  onOpen,
  onClose,
}: {
  notif: Notifications;
  onOpen: (href: string) => void;
  onClose: () => void;
}) {
  const { translate, relative } = useI18n();

  function open(item: NotificationItem) {
    void notif.markRead(item.id);
    onOpen(item.deep_link);
  }

  return (
    <div
      role="dialog"
      aria-label={translate("通知")}
      className="fixed inset-x-2 top-20 z-50 max-h-[70vh] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-96"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold">{translate("通知")}</h2>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={!notif.unreadOnly}
            className={!notif.unreadOnly ? "text-indigo-700" : "text-slate-500"}
            onPress={() => notif.unreadOnly && notif.toggleUnread()}
          >
            {translate("全部")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={notif.unreadOnly}
            className={notif.unreadOnly ? "text-indigo-700" : "text-slate-500"}
            onPress={() => !notif.unreadOnly && notif.toggleUnread()}
          >
            {translate("仅未读")}
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2">
        <span className="text-xs text-slate-500" role="status">
          {translate("{count} 条未读", { count: notif.count })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          isDisabled={notif.count === 0}
          onPress={() => void notif.markAllRead()}
        >
          <Icon name="check" className="size-4" />
          {translate("全部标为已读")}
        </Button>
      </div>
      <div className="max-h-[52vh] overflow-y-auto">
        {notif.error && !notif.items.length ? (
          <div role="alert" className="space-y-3 p-4">
            <p className="font-medium">{translate("无法加载通知")}</p>
            <Message error={notif.error} />
            <Button
              variant="primary"
              size="sm"
              onPress={() => notif.refreshList()}
            >
              {translate("重试")}
            </Button>
          </div>
        ) : notif.loading && !notif.items.length ? (
          <div role="status" aria-busy="true" className="space-y-3 p-4">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-10 w-full rounded bg-slate-100 motion-safe:animate-pulse"
              />
            ))}
          </div>
        ) : notif.items.length === 0 ? (
          <div className="space-y-4 p-4">
            <Empty title={translate("暂无通知")}>
              {translate("有新的待办时会在这里提醒你。")}
            </Empty>
            <div className="text-center">
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  onClose();
                  onOpen("/me/work");
                }}
              >
                {translate("前往我的工作")}
              </Button>
            </div>
          </div>
        ) : (
          <ul>
            {notif.items.map((item) => (
              <li key={item.id}>
                <a
                  href={item.deep_link}
                  onClick={(event) => {
                    event.preventDefault();
                    open(item);
                  }}
                  className="flex gap-3 border-t border-slate-100 px-4 py-3 outline-offset-2 first:border-t-0 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-600"
                >
                  <span
                    aria-hidden="true"
                    className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${item.read ? "bg-transparent" : "bg-indigo-500"}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-500">
                        {item.project_name}
                      </span>
                      <time
                        dateTime={item.occurred_at}
                        className="shrink-0 text-xs text-slate-400"
                      >
                        {relative(item.occurred_at)}
                      </time>
                    </span>
                    <span className="block text-xs font-medium text-indigo-700">
                      {translate(notificationLabelKey(item.type))}
                    </span>
                    <span
                      className={`block truncate text-sm ${item.read ? "text-slate-600" : "font-medium text-slate-900"}`}
                    >
                      {item.title || translate("通知")}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      {notif.hasMore && (
        <div className="border-t border-slate-100 p-2 text-center">
          <Button
            variant="ghost"
            size="sm"
            isDisabled={notif.loading}
            onPress={() => notif.loadMore()}
          >
            {translate("加载更多")}
          </Button>
        </div>
      )}
    </div>
  );
}

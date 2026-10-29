import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { ApiError, type Membership, type Page } from "../api";
import type { Workspace } from "../app/types";
import { Button, Message } from "../ui";

/** Shared textarea styling so the comment inputs match the app's form controls
 * while remaining native elements (needed for the caret/selection the mention
 * picker reads). */
const textareaClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-indigo-600 disabled:bg-slate-50 read-only:bg-slate-50";
import { MentionPopover } from "./MentionPopover";

export type CommentItem = {
  id: string;
  task_id: string;
  author_user_id: string;
  author_name: string;
  body: string;
  mentions: string[];
  edited: boolean;
  deleted: boolean;
  created_at: string;
  updated_at: string;
};

// --- Pure helpers (unit-tested in web/tests/comments.spec.ts) ----------------

/** Oldest-first chronological order (O-W14); stable by id on equal timestamps. */
export function sortComments(items: CommentItem[]): CommentItem[] {
  return [...items].sort((a, b) =>
    a.created_at === b.created_at
      ? a.id.localeCompare(b.id)
      : a.created_at.localeCompare(b.created_at),
  );
}

/** Detect an active "@token" ending at the caret so the picker only opens while
 * typing a mention. The "@" must begin the text or follow whitespace, and the
 * token itself must be whitespace-free. Returns the token start and query, else
 * null. */
export function detectMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query };
}

/** Active members whose display name or id matches the case-insensitive query. */
export function filterMentionCandidates(
  members: Membership[],
  query: string,
): Membership[] {
  const q = query.trim().toLowerCase();
  return members
    .filter((m) => m.active)
    .filter(
      (m) =>
        q === "" ||
        m.display_name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q),
    );
}

/** Replace the active "@query" token (text[start..caret]) with "@name " and
 * return the new text plus caret position. */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  member: Membership,
): { text: string; caret: number } {
  const insert = "@" + member.display_name + " ";
  return {
    text: text.slice(0, start) + insert + text.slice(caret),
    caret: start + insert.length,
  };
}

/** Resolve the member ids mentioned in the body by "@display_name", what is
 * sent to the server. At each "@" the longest active member name that both
 * matches and is followed by a boundary (end-of-text, whitespace or
 * punctuation) wins and consumes its span, so a shorter name that is a prefix
 * of another (e.g. "Bob" of "Bobby") is never also matched. Deduplicated and
 * restricted to active members. */
export function resolveMentions(text: string, members: Membership[]): string[] {
  const active = [...members]
    .filter((x) => x.active)
    .sort((a, b) => b.display_name.length - a.display_name.length);
  const isBoundary = (ch: string | undefined) =>
    ch === undefined || !/[\p{L}\p{N}]/u.test(ch);
  const ids: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    for (const m of active) {
      const name = m.display_name;
      if (
        text.startsWith(name, i + 1) &&
        isBoundary(text[i + 1 + name.length])
      ) {
        if (!ids.includes(m.id)) ids.push(m.id);
        i += name.length; // consume the matched span
        break;
      }
    }
  }
  return ids;
}

/** Message key for a failed post: an invalid mention is called out specifically
 * (O-W15) so the author can fix it; everything else is the generic failure. */
export function sendErrorKey(
  error: unknown,
): "无法提及无效成员" | "无法发送评论" {
  if (error instanceof ApiError && error.code === "INVALID_MENTION")
    return "无法提及无效成员";
  return "无法发送评论";
}

// --- Component ----------------------------------------------------------------

/**
 * Advisory comment block (F11). Mounted as a fixed region below the TaskDetail
 * Tabs (O-W13), away from the status action area, so it is never mistaken for a
 * transition control. The thread is chronological ascending and auto-scrolls to
 * the newest comment on post (O-W14); a send failure keeps the draft (including
 * @mentions) and shows an error; the "发送评论" button is a plain secondary
 * button, not a primary status action (O-W14). An @mention picker (O-W15)
 * opens while typing "@" or from the "提及成员" button.
 */
export function TaskComments({
  w,
  taskID,
  archived,
}: {
  w: Workspace;
  taskID: string;
  archived?: boolean;
}) {
  const { translate, relative } = useI18n();
  const [items, setItems] = useState<CommentItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<unknown>();
  const [posted, setPosted] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string }>();
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const member = w.members.find((m) => m.id === w.me.id);
  const canComment = !archived && !!member?.active;

  function scrollToEnd() {
    requestAnimationFrame(() =>
      endRef.current?.scrollIntoView({ block: "end" }),
    );
  }

  useEffect(() => {
    let live = true;
    setLoading(true);
    w.api
      .call<Page<CommentItem>>(`/tasks/${taskID}/comments`)
      .then((page) => {
        if (!live) return;
        setItems(sortComments(page.items));
        setCursor(page.next_cursor ?? null);
        setLoadError(undefined);
        scrollToEnd();
      })
      .catch((cause) => live && setLoadError(cause))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [taskID, w.api]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const page = await w.api.call<Page<CommentItem>>(
        `/tasks/${taskID}/comments?cursor=${encodeURIComponent(cursor)}`,
      );
      setItems((prev) => sortComments([...prev, ...page.items]));
      setCursor(page.next_cursor ?? null);
    } catch (cause) {
      setLoadError(cause);
    } finally {
      setLoading(false);
    }
  }

  function onDraftChange(value: string, caret: number) {
    setDraft(value);
    setPosted(false);
    setMention(detectMention(value, caret) ?? undefined);
  }

  function choose(picked: Membership) {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const token = mention ??
      detectMention(draft, caret) ?? {
        start: caret,
        query: "",
      };
    const next = applyMention(draft, token.start, caret, picked);
    setDraft(next.text);
    setMention(undefined);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  }

  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setSendError(undefined);
    setPosted(false);
    try {
      const mentions = resolveMentions(draft, w.members);
      const created = await w.api.call<CommentItem>(
        `/tasks/${taskID}/comments`,
        mentions.length ? { body: draft, mentions } : { body: draft },
      );
      setItems((prev) => sortComments([...prev, created]));
      setDraft(""); // Success clears the draft; failure (below) preserves it.
      setMention(undefined);
      setPosted(true);
      scrollToEnd();
    } catch (cause) {
      setSendError(cause); // Keep the draft (incl. @mentions) so it can be retried.
    } finally {
      setSending(false);
    }
  }

  const mentionCandidates = mention
    ? filterMentionCandidates(w.members, mention.query)
    : [];

  return (
    <section
      className="rounded-xl border border-slate-200 bg-white p-5 sm:p-8"
      aria-label={translate("任务评论")}
    >
      <h2 className="text-xl font-semibold">{translate("评论")}</h2>
      <p className="mt-1 mb-4 flex items-start gap-2 text-sm text-slate-500">
        <span aria-hidden="true">ⓘ</span>
        <span>{translate("评论仅为建议性讨论，不会改变任务状态。")}</span>
      </p>

      {loadError !== undefined ? (
        <div role="alert" className="space-y-2">
          <p className="font-medium">{translate("无法加载评论")}</p>
          <Message error={loadError} />
        </div>
      ) : loading && items.length === 0 ? (
        <div role="status" aria-busy="true" className="space-y-3">
          {[0, 1].map((row) => (
            <div
              key={row}
              className="h-12 w-full rounded bg-slate-100 motion-safe:animate-pulse"
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500">{translate("还没有评论")}</p>
      ) : (
        <ul className="space-y-4" aria-label={translate("任务评论")}>
          {items.map((item) => (
            <li key={item.id} className="text-sm">
              <div className="flex flex-wrap items-center gap-2 text-slate-500">
                <span className="font-medium text-slate-800">
                  {item.author_name || item.author_user_id}
                </span>
                <time dateTime={item.created_at} className="text-xs">
                  {relative(item.created_at)}
                </time>
                {item.edited && !item.deleted && (
                  <span className="text-xs">· {translate("已编辑")}</span>
                )}
              </div>
              {item.deleted ? (
                <p className="mt-1 text-slate-400 italic">—</p>
              ) : (
                <p className="mt-1 whitespace-pre-wrap text-slate-700">
                  {item.body}
                </p>
              )}
              {!item.deleted && item.author_user_id === w.me.id && (
                <CommentActions
                  w={w}
                  taskID={taskID}
                  comment={item}
                  onChanged={(updated) =>
                    setItems((prev) =>
                      sortComments(
                        prev.map((c) => (c.id === updated.id ? updated : c)),
                      ),
                    )
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            isDisabled={loading}
            onPress={() => void loadMore()}
          >
            {translate("加载更多")}
          </Button>
        </div>
      )}

      <div ref={endRef} />

      {canComment ? (
        <div
          ref={composerRef}
          className="relative mt-5 border-t border-slate-100 pt-5"
        >
          {sendError !== undefined && (
            <div role="alert" className="mb-2">
              <p className="text-sm font-medium text-rose-700">
                {translate(sendErrorKey(sendError))}
              </p>
              <Message error={sendError} />
            </div>
          )}
          {posted && (
            <p role="status" aria-live="polite" className="sr-only">
              {translate("评论已发送")}
            </p>
          )}
          <textarea
            ref={inputRef}
            aria-label={translate("评论")}
            rows={3}
            value={draft}
            readOnly={sending}
            className={textareaClass}
            placeholder={translate("写下建议或问题… 输入 @ 可提及成员")}
            onChange={(event) =>
              onDraftChange(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              )
            }
            onKeyDown={(event) => {
              if (!mention) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                composerRef.current
                  ?.querySelector<HTMLButtonElement>('[role="option"]')
                  ?.focus();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setMention(undefined);
              }
            }}
          />
          {mention && (
            <MentionPopover
              candidates={mentionCandidates}
              onSelect={choose}
              onClose={() => {
                setMention(undefined);
                inputRef.current?.focus();
              }}
            />
          )}
          {/* The send control is a plain secondary button, deliberately not a
              primary status action and not placed beside the task's transition
              buttons (O-W14). */}
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="secondary"
              isDisabled={!draft.trim() || sending}
              onPress={() => void send()}
            >
              {translate("发送评论")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                const caret = inputRef.current?.selectionStart ?? draft.length;
                setMention(
                  detectMention(draft, caret) ?? { start: caret, query: "" },
                );
                inputRef.current?.focus();
              }}
            >
              {translate("提及成员")}
            </Button>
          </div>
        </div>
      ) : (
        !archived && (
          <p className="mt-5 border-t border-slate-100 pt-5 text-sm text-slate-500">
            {translate("你没有权限评论")}
          </p>
        )
      )}
    </section>
  );
}

/** Author-only edit/delete menu for one comment (O-W14 / §6.2.5). */
function CommentActions({
  w,
  taskID,
  comment,
  onChanged,
}: {
  w: Workspace;
  taskID: string;
  comment: CommentItem;
  onChanged: (updated: CommentItem) => void;
}) {
  const { translate } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function saveEdit() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await w.api.call<CommentItem>(
        `/tasks/${taskID}/comments/${comment.id}/edit`,
        { body: draft },
      );
      onChanged(updated);
      setEditing(false);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // A non-undefined body makes api.call issue a POST (not a GET) and attach
      // an Idempotency-Key; the delete route accepts an empty object.
      const updated = await w.api.call<CommentItem>(
        `/tasks/${taskID}/comments/${comment.id}/delete`,
        {},
      );
      onChanged(updated);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="mt-2 space-y-2">
        <textarea
          aria-label={translate("编辑")}
          rows={2}
          value={draft}
          readOnly={busy}
          className={textareaClass}
          onChange={(event) => setDraft(event.target.value)}
        />
        {error !== undefined && <Message error={error} />}
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            isDisabled={!draft.trim() || busy}
            onPress={() => void saveEdit()}
          >
            {translate("保存")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              setDraft(comment.body);
              setEditing(false);
            }}
          >
            {translate("取消")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 flex gap-3">
      <button
        type="button"
        className="text-xs text-slate-500 hover:text-slate-800"
        onClick={() => setEditing(true)}
      >
        {translate("编辑")}
      </button>
      <button
        type="button"
        className="text-xs text-slate-500 hover:text-rose-700"
        onClick={() => void remove()}
      >
        {translate("删除")}
      </button>
      {error !== undefined && <Message error={error} />}
    </div>
  );
}

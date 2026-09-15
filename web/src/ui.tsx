import { useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { label, ApiError } from "./api";
export function Badge({ value }: { value: string }) {
  return <span className={`badge badge-${value}`}>{label(value)}</span>;
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">◇</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Field({
  label: title,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{title}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Message({ error }: { error: unknown }) {
  const text = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="notice error">
      {text}
      {error instanceof ApiError && (
        <small>
          {error.code} · {error.trace}
        </small>
      )}
    </div>
  );
}
export function Form({
  action,
  children,
  submit = "保存",
  onDone,
}: {
  action: (data: FormData) => Promise<unknown>;
  children: ReactNode;
  submit?: string;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const data = new FormData(e.currentTarget);
    try {
      await action(data);
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={send}>
      {children}
      {error !== undefined && <Message error={error} />}
      <div className="form-actions">
        <button className="primary" disabled={busy}>
          {busy ? "处理中…" : submit}
        </button>
      </div>
    </form>
  );
}
export function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={close}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button aria-label="关闭" className="icon-button" onClick={close}>
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Json({ data }: { data: unknown }) {
  return <pre className="json">{JSON.stringify(data, null, 2)}</pre>;
}
export function Action({
  children,
  run,
  danger = false,
}: {
  children: ReactNode;
  run: () => Promise<unknown>;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <span className="action">
      <button
        className={danger ? "danger" : "secondary"}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await run();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "处理中…" : children}
      </button>
      {error !== undefined && <Message error={error} />}
    </span>
  );
}
export const text = (data: FormData, name: string) =>
  String(data.get(name) || "").trim();

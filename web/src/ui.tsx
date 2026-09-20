import { useI18n, LocalizedError } from "./i18n";
import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useRef,
  useState,
} from "react";
import type { ComponentProps, FormEvent, ReactNode } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox as HeroCheckbox,
  Chip,
  Description,
  FieldError,
  Form as HeroForm,
  Input as HeroInput,
  Label,
  ListBox,
  Modal as HeroModal,
  Select as HeroSelect,
  Spinner,
  TextArea as HeroTextArea,
  TextField,
} from "@heroui/react";
import { ApiError, PendingSubmission, VersionConflict } from "./api";

export { Button } from "@heroui/react";

export function Badge({ value }: { value: string }) {
  const { label } = useI18n();

  const color = [
    "DONE",
    "SUCCEEDED",
    "ACCEPTED",
    "APPROVED",
    "VERIFIED",
    "PUBLISHED",
    "ACTIVE",
    "SUCCESS",
  ].includes(value)
    ? "success"
    : ["RUNNING", "READY"].includes(value)
      ? "accent"
      : [
            "IN_REVIEW",
            "PENDING",
            "AWAITING_APPROVAL",
            "HIGH",
            "BLOCKED",
          ].includes(value)
        ? "warning"
        : ["REJECTED", "FAILED", "UNKNOWN", "DENIED", "REVOKED"].includes(value)
          ? "danger"
          : "default";
  return (
    <Chip color={color} size="sm" variant="soft">
      {label(value)}
    </Chip>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <Card className="empty">
      <Card.Content>
        <div
          className="mx-auto grid size-12 place-items-center rounded-xl bg-slate-100 text-2xl text-slate-600"
          aria-hidden="true"
        >
          ◇
        </div>
        <h3>{title}</h3>
        <p>{children}</p>
      </Card.Content>
    </Card>
  );
}

// Each control owns its HeroUI label, description and validation context.
const FieldContext = createContext<
  { title: string; hint?: string } | undefined
>(undefined);
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
    <FieldContext.Provider value={{ title, hint }}>
      <div className="field">{children}</div>
    </FieldContext.Provider>
  );
}
function FieldLabel() {
  const field = useContext(FieldContext);
  return field && <Label>{field.title}</Label>;
}
function FieldFeedback() {
  const field = useContext(FieldContext);
  return (
    <>
      {field?.hint && <Description>{field.hint}</Description>}
      <FieldError />
    </>
  );
}
export function Input({
  required,
  disabled,
  readOnly,
  className,
  defaultValue,
  ...props
}: Omit<ComponentProps<typeof HeroInput>, "className"> & {
  className?: string;
}) {
  return (
    <TextField
      className={className}
      isRequired={required}
      isDisabled={disabled}
      isReadOnly={readOnly}
      defaultValue={
        defaultValue === undefined ? undefined : String(defaultValue)
      }
      aria-label={props["aria-label"]}
    >
      <FieldLabel />
      <HeroInput {...props} />
      <FieldFeedback />
    </TextField>
  );
}
export function TextArea({
  required,
  disabled,
  readOnly,
  ...props
}: ComponentProps<typeof HeroTextArea>) {
  return (
    <TextField
      isRequired={required}
      isDisabled={disabled}
      isReadOnly={readOnly}
    >
      <FieldLabel />
      <HeroTextArea {...props} />
      <FieldFeedback />
    </TextField>
  );
}

type OptionProps = { value: string; children: ReactNode; disabled?: boolean };
type SelectProps = {
  children: ReactNode;
  name?: string;
  value?: string;
  defaultValue?: string;
  multiple?: boolean;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  onChange?: (value: string) => void;
};
// Keep declarative option data at call sites; HeroUI renders the actual listbox.
// Match native single-select defaults, including options loaded asynchronously.
export function Select({
  children,
  name,
  value,
  defaultValue,
  multiple = false,
  required,
  disabled,
  onChange,
  ...props
}: SelectProps) {
  const { translate } = useI18n();

  const options = Children.toArray(children).filter(
    isValidElement<OptionProps>,
  );
  const [selection, setSelection] = useState<string | string[] | null>(
    defaultValue ?? null,
  );
  const selected =
    value ??
    selection ??
    (multiple
      ? []
      : (options.find((o) => !o.props.disabled)?.props.value ?? null));
  return (
    <HeroSelect
      {...props}
      name={name}
      fullWidth
      selectionMode={multiple ? "multiple" : "single"}
      value={selected}
      isRequired={required}
      isDisabled={disabled}
      placeholder={multiple ? translate("请选择执行依据") : translate("请选择")}
      disabledKeys={options
        .filter((o) => o.props.disabled)
        .map((o) => o.props.value)}
      onChange={(next) => {
        const normalized = Array.isArray(next)
          ? next.map(String)
          : next === null
            ? null
            : String(next);
        setSelection(normalized);
        if (!Array.isArray(normalized)) onChange?.(normalized ?? "");
      }}
    >
      <FieldLabel />
      <HeroSelect.Trigger>
        <HeroSelect.Value />
        <HeroSelect.Indicator />
      </HeroSelect.Trigger>
      <FieldFeedback />
      <HeroSelect.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.props.value}
              id={option.props.value}
              textValue={Children.toArray(option.props.children).join("")}
            >
              <Label>{option.props.children}</Label>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
    </HeroSelect>
  );
}
export function Checkbox({
  children,
  ...props
}: Omit<ComponentProps<typeof HeroCheckbox>, "children"> & {
  children: ReactNode;
}) {
  return (
    <HeroCheckbox {...props}>
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label>{children}</Label>
      </HeroCheckbox.Content>
    </HeroCheckbox>
  );
}
export function Message({ error }: { error: unknown }) {
  const { translate } = useI18n();

  const message =
    error instanceof LocalizedError
      ? translate(error.key)
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <Alert role="alert" status="danger" className="my-4 break-words">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{message}</Alert.Title>
        {error instanceof ApiError && (
          <Alert.Description>
            {error.code} · {error.trace}
          </Alert.Description>
        )}
        {error instanceof VersionConflict && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              本次提交
              <Json data={error.submitted} />
            </div>
            <div>
              当前版本
              <Json data={error.current} />
            </div>
          </div>
        )}
        {error instanceof PendingSubmission && (
          <Action
            run={async () => {
              await error.retry();
              window.dispatchEvent(new Event("accp:confirmed"));
            }}
          >
            重试原请求
          </Action>
        )}
      </Alert.Content>
    </Alert>
  );
}
export function Form({
  action,
  children,
  submit,
  onDone,
}: {
  action: (data: FormData) => Promise<unknown>;
  children: ReactNode;
  submit?: string;
  onDone?: () => void;
}) {
  const { translate } = useI18n();

  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<unknown>();
  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    const data = new FormData(e.currentTarget);
    try {
      await action(data);
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <HeroForm onSubmit={send} aria-busy={busy}>
      {children}
      {error !== undefined && <Message error={error} />}
      <div className="form-actions">
        <Button type="submit" isDisabled={busy} aria-busy={busy}>
          {busy && <Spinner size="sm" color="current" />}
          {busy ? translate("处理中…") : (submit ?? translate("保存"))}
        </Button>
      </div>
    </HeroForm>
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
  const { translate } = useI18n();

  return (
    <HeroModal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      isDismissable
      variant="blur"
    >
      <HeroModal.Container size="lg" scroll="inside">
        <HeroModal.Dialog>
          <HeroModal.CloseTrigger aria-label={translate("关闭")} />
          <HeroModal.Header>
            <HeroModal.Heading>{title}</HeroModal.Heading>
          </HeroModal.Header>
          <HeroModal.Body>{children}</HeroModal.Body>
        </HeroModal.Dialog>
      </HeroModal.Container>
    </HeroModal.Backdrop>
  );
}
export function Json({ data }: { data: unknown }) {
  return (
    <pre className="my-4 max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-xs leading-6 whitespace-pre-wrap break-all">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
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
  const { translate } = useI18n();

  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<unknown>();
  return (
    <div className="inline-flex flex-col gap-2">
      <Button
        variant={danger ? "danger-soft" : "secondary"}
        isDisabled={busy}
        aria-busy={busy}
        onPress={async () => {
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError(undefined);
          try {
            await run();
          } catch (e) {
            setError(e);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner size="sm" color="current" />}
        {busy ? translate("处理中…") : children}
      </Button>
      {error !== undefined && <Message error={error} />}
    </div>
  );
}
export const text = (data: FormData, name: string) =>
  String(data.get(name) || "").trim();

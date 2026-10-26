import { useI18n } from "../i18n";
import { useEffect, useRef, type ReactNode } from "react";
import { Card } from "@heroui/react";
import { Button } from "../ui";
import { CopyLink } from "../CopyLink";
import { routePath } from "../routing";

function StatusCard({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} · ACCP`;
    heading.current?.focus();
  }, [title]);
  return (
    <Card className="empty">
      <Card.Content>
        <div
          className="mx-auto grid size-12 place-items-center rounded-xl bg-slate-100 text-2xl text-slate-600"
          aria-hidden="true"
        >
          ◇
        </div>
        <h1 ref={heading} tabIndex={-1} className="outline-none">
          {title}
        </h1>
        <p className="mx-auto max-w-prose">{children}</p>
        {actions && (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {actions}
          </div>
        )}
      </Card.Content>
    </Card>
  );
}

/** O4 — unknown page segment / decode failure / extra path parts. */
export function InvalidLinkPage({
  projectID,
  onBack,
}: {
  projectID: string;
  onBack: (href: string) => void;
}) {
  const { translate } = useI18n();
  const overviewHref = projectID
    ? routePath({ projectID, page: "overview" })
    : "/";
  return (
    <StatusCard
      title={translate("链接失效")}
      actions={
        <Button
          variant="primary"
          className="h-10"
          onPress={() => onBack(overviewHref)}
        >
          {projectID ? translate("返回项目概览") : translate("返回首页")}
        </Button>
      }
    >
      {translate("这个链接的地址不正确或已不再可用。")}
    </StatusCard>
  );
}

/** 404 — missing resource or not a project member (no existence leak). */
export function NotFoundPage({
  backHref,
  backLabel,
  onBack,
}: {
  backHref?: string;
  backLabel?: string;
  onBack?: (href: string) => void;
}) {
  const { translate } = useI18n();
  return (
    <StatusCard
      title={translate("找不到或无权访问")}
      actions={
        <>
          {backHref && onBack && (
            <Button
              variant="primary"
              className="h-10"
              onPress={() => onBack(backHref)}
            >
              {backLabel ?? translate("返回任务列表")}
            </Button>
          )}
          <CopyLink />
        </>
      }
    >
      {translate(
        "链接可能已失效，或你不是该项目的成员。请检查链接，或联系项目管理员。",
      )}
    </StatusCard>
  );
}

/** 403 — member without sufficient role. */
export function ForbiddenPage() {
  const { translate } = useI18n();
  return (
    <StatusCard title={translate("此页面需要更高权限")}>
      {translate("请联系项目管理员确认你的访问权限。")}
    </StatusCard>
  );
}

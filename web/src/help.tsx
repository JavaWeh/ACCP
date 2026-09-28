import { useI18n } from "./i18n";

export function Help() {
  const { translate: t } = useI18n();
  const steps = [
    ["准备项目资料", "发布需求或接口说明，任务只能使用已发布的版本。"],
    [
      "创建任务",
      "写明目标和验收条件，指定项目成员负责，并选择代码仓库与资料。",
    ],
    [
      "提交执行",
      "负责人检查任务草稿后安排执行；执行进展、报告和成果保留在任务详情。",
    ],
    ["验收交付", "负责人核对每条验收条件与已核验成果，决定接受或退回修改。"],
  ] as const;
  return (
    <div className="page-enter grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
      <section className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
        <h2 className="text-xl font-semibold">{t("从任务到交付")}</h2>
        <p className="mt-2 text-sm leading-7 text-slate-600">
          {t("每项任务都由项目成员负责，系统保存执行过程与人工验收记录。")}
        </p>
        <ol className="mt-7 space-y-6">
          {steps.map(([title, detail], index) => (
            <li key={title} className="flex gap-4">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-indigo-50 font-semibold text-indigo-700">
                {index + 1}
              </span>
              <div>
                <h3 className="mb-1">{t(title)}</h3>
                <p className="text-sm leading-6 text-slate-600">{t(detail)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <div className="space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold">{t("谁能做什么")}</h2>
          <p className="mt-3 text-sm leading-7 text-slate-600">
            {t(
              "项目成员创建和执行任务；审核人处理审批与审计；管理员配置项目、工具和运行状态。",
            )}
          </p>
        </section>
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-6">
          <h2 className="text-lg font-semibold">{t("遇到问题时")}</h2>
          <p className="mt-3 text-sm leading-7 text-slate-700">
            {t(
              "先刷新任务查看最新状态。写入结果不明时保留原操作并重试；管理中心可查看运行诊断和导出支持信息。",
            )}
          </p>
        </section>
      </div>
    </div>
  );
}

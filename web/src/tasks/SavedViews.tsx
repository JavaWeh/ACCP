import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { Workspace } from "../main";
import { Button, Input, Modal, Select } from "../ui";
import {
  parseTaskListSearch,
  serializeTaskListSearch,
  taskListSearchEquals,
  type TaskListQuery,
} from "./taskListSearchParams";
import {
  readSavedViews,
  removeSavedView,
  upsertSavedView,
  writeSavedViews,
  type SavedView,
} from "./savedViewModel";

export function SavedViews({
  w,
  query,
  onApplyView,
  canSave,
}: {
  w: Workspace;
  query: TaskListQuery;
  onApplyView: (search: string) => void;
  canSave: boolean;
}) {
  const { translate } = useI18n();
  const projectId = w.project.id;
  const [views, setViews] = useState<SavedView[]>(() =>
    readSavedViews(projectId),
  );
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [announce, setAnnounce] = useState("");
  const skipMount = useRef(true);

  // Reload views when switching projects (views are stored per project).
  useEffect(() => {
    if (skipMount.current) {
      skipMount.current = false;
      return;
    }
    setViews(readSavedViews(projectId));
  }, [projectId]);

  const active = views.find((v) =>
    taskListSearchEquals(parseTaskListSearch(v.search).query, query),
  );

  const persist = (next: SavedView[]) => {
    setViews(next);
    writeSavedViews(projectId, next);
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    persist(upsertSavedView(views, trimmed, serializeTaskListSearch(query)));
    setAnnounce(translate("已保存视图「{name}」", { name: trimmed }));
    setSaving(false);
    setName("");
  };

  const remove = () => {
    if (!active) return;
    persist(removeSavedView(views, active.name));
    setAnnounce(translate("已删除视图「{name}」", { name: active.name }));
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-slate-600">{translate("视图")}</span>
      <Select
        aria-label={translate("已保存的视图")}
        value={active?.name ?? ""}
        disabled={views.length === 0}
        onChange={(next) => {
          if (!next) return;
          const view = views.find((v) => v.name === next);
          if (view) onApplyView(view.search);
        }}
      >
        <option value="">
          {views.length ? translate("选择视图") : translate("没有已保存的视图")}
        </option>
        {views.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name}
          </option>
        ))}
      </Select>
      {canSave && (
        <Button
          variant="ghost"
          onPress={() => {
            setName(active?.name ?? "");
            setSaving(true);
          }}
        >
          {translate("保存为视图")}
        </Button>
      )}
      {canSave && active && (
        <Button variant="ghost" onPress={remove}>
          {translate("删除视图")}
        </Button>
      )}

      {saving && (
        <Modal title={translate("保存视图")} close={() => setSaving(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Input
              aria-label={translate("视图名称")}
              placeholder={translate("视图名称")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onPress={() => setSaving(false)}>
                {translate("取消")}
              </Button>
              <Button type="submit" variant="primary" isDisabled={!name.trim()}>
                {translate("保存")}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>
    </div>
  );
}

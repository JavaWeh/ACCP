import { useCallback, useEffect, useRef, useState } from "react";
import type { Doc, Page } from "./api";
import type { Workspace } from "./main";
import { Button, Message } from "./ui";
import { navigate, useLocationQuery } from "./navigation";
const emptyItems: Doc[] = [];

export function usePage(
  w: Workspace,
  path: string,
  key: string,
  enabled = true,
  filters = "",
) {
  const query = useLocationQuery(),
    cursor = query.get(key) || "";
  const [data, setData] = useState<Page>({ items: [] }),
    [error, setError] = useState<unknown>(),
    [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const [loadedPath, setLoadedPath] = useState("");
  const load = useCallback(async () => {
    const current = ++generation.current;
    if (!enabled) {
      setData({ items: [] });
      return;
    }
    setLoading(true);
    try {
      const result = await w.api.call<Page>(
        `${path}?limit=25${filters ? "&" + filters : ""}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      if (current !== generation.current) return;
      setData(result);
      setLoadedPath(path);
      setError(undefined);
    } catch (e) {
      if (current === generation.current) setError(e);
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [w.api, path, cursor, enabled, filters]);
  useEffect(() => {
    void load();
    return () => {
      ++generation.current;
    };
  }, [load, w.revision]);
  return {
    items: loadedPath === path && enabled ? data.items : emptyItems,
    load,
    controls: (
      <div className="my-3 flex flex-wrap items-center gap-3">
        <span className="text-xs">
          每页 25 条{loading ? " · 正在读取" : ""}
        </span>
        <Button
          variant="ghost"
          isDisabled={!cursor}
          onPress={() => navigate({ [key]: undefined })}
        >
          首页
        </Button>
        <Button
          variant="secondary"
          isDisabled={!data.next_cursor || loading}
          onPress={() => navigate({ [key]: data.next_cursor! })}
        >
          下一页
        </Button>
        {error !== undefined && <Message error={error} />}
      </div>
    ),
  };
}

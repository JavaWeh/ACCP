import { useRef } from "react";
import { useI18n } from "../i18n";
import type { Membership } from "../api";

/**
 * @mention picker (O-W15). A keyboard-reachable listbox of active project
 * members; it opens while typing an "@token" or from the "提及成员" button.
 * The textarea keeps focus while typing (so the query stays editable);
 * ArrowDown from the textarea moves focus into the list, where ArrowUp/Down
 * move between options, Enter inserts the focused member and Esc closes and
 * returns focus to the input. Candidates are already filtered by the caller
 * (TaskComments) so this stays a presentation component.
 */
export function MentionPopover({
  candidates,
  onSelect,
  onClose,
}: {
  candidates: Membership[];
  onSelect: (member: Membership) => void;
  onClose: () => void;
}) {
  const { translate } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  function move(from: HTMLElement, delta: number) {
    const options = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
    const index = options.indexOf(from as HTMLButtonElement);
    const next = options[index + delta];
    next?.focus();
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={translate("提及成员")}
      className="absolute z-20 mt-1 max-h-56 w-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          move(event.target as HTMLElement, 1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(event.target as HTMLElement, -1);
        }
      }}
    >
      {candidates.length === 0 ? (
        <p className="px-3 py-2 text-sm text-slate-500">
          {translate("没有可提及的成员")}
        </p>
      ) : (
        candidates.map((member) => (
          <button
            key={member.id}
            type="button"
            role="option"
            aria-selected={false}
            aria-label={translate("提及成员") + "：" + member.display_name}
            className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm outline-offset-2 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-600"
            onClick={() => onSelect(member)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(member);
              }
            }}
          >
            <span className="font-medium text-slate-900">
              {member.display_name}
            </span>
            <span className="text-xs text-slate-500">{member.id}</span>
          </button>
        ))
      )}
    </div>
  );
}

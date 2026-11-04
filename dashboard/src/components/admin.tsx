import { ChevronRight, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { ConfigChange, HistoryEntry } from "../api";
import { type ChangeNames, describeChange } from "../lib/admin-logic";

export type { ChangeNames };
import { Button, Card, Dialog, ErrorNote, Input, Segmented, Textarea, VersionBadge, formatDate } from "./ui";

/**
 * Pieces shared by the scorecard and goal editors (P1-18): the page header, the version switch, the bar that says
 * whether you are looking at the live version or a draft, the list of changes, version history, and the publish /
 * discard confirmations.
 */

export function PageHeader({ crumb, title, subtitle, actions }: { crumb: { href: string; label: string }; title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-xs text-muted">
          <a href={crumb.href} className="hover:text-ink">
            {crumb.label}
          </a>
          <ChevronRight size={12} aria-hidden />
        </nav>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export type View = "draft" | "published";

/** Switches between the draft and the live version; shown only when a draft exists. */
export function VersionSwitch({ view, onChange, draft, published }: { view: View; onChange: (v: View) => void; draft: number; published: number }) {
  return (
    <Segmented<View>
      legend="Version"
      value={view}
      onChange={onChange}
      options={[
        ["draft", `Draft v${draft}`],
        ["published", `Published v${published}`],
      ]}
    />
  );
}

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
export const usedBy = (agents: { label: string }[]) => (agents.length ? `Used by ${joinNames(agents.map((a) => a.label))}` : "No agent uses it yet");

/** The live version: read-only, with the way into a draft. */
export function PublishedBar({ version, publishedAt, action }: { version: number; publishedAt: string | null; action: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <VersionBadge status="published" version={version} />
        <span>Live{publishedAt ? ` since ${formatDate(publishedAt)}` : ""}. Read-only: changes go in a draft.</span>
      </div>
      {action}
    </div>
  );
}

/**
 * The draft: not live yet. It stays in view while scrolling, with the save state and the way to publish. Publishing
 * is blocked (with the reason) while edits are unsaved, when nothing changed, or when the draft isn't complete.
 */
export function DraftBar({
  version,
  liveVersion,
  who,
  changes,
  unsaved,
  saving,
  onSave,
  onDiscard,
  onReview,
  blockedBecause,
}: {
  version: number;
  liveVersion: number | null;
  who: string;
  changes: number;
  unsaved: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReview: () => void;
  blockedBecause: string | null;
}) {
  const reasonId = useId();
  return (
    <div className="z-10 -mx-1 rounded-xl sm:sticky sm:top-0 border border-warning/50 bg-warning-soft px-4 py-3 shadow-[0_0_0_4px_var(--bg)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink">
          <VersionBadge status="draft" version={version} />
          <span>
            Not live.{liveVersion !== null && ` ${who} still on v${liveVersion}.`}
          </span>
          <span className="text-ink-2 tabular" aria-live="polite">
            {unsaved ? "Unsaved changes" : changes === 0 ? "No changes yet" : `${changes} ${changes === 1 ? "change" : "changes"} saved`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" compact onClick={onDiscard}>
            Discard draft
          </Button>
          <Button variant="secondary" compact onClick={onSave} disabled={!unsaved || saving}>
            {saving ? "Saving…" : "Save draft"}
          </Button>
          <Button variant="primary" compact onClick={onReview} disabled={blockedBecause !== null} aria-describedby={blockedBecause ? reasonId : undefined}>
            Review and publish
          </Button>
        </div>
      </div>
      {blockedBecause && (
        <p id={reasonId} className="mt-1.5 text-xs text-ink-2 sm:text-right">
          {blockedBecause}
        </p>
      )}
    </div>
  );
}

/** Changes as rows: the field, then before → after (long text is clipped; the full value is in the title). */
export function ChangeList({ changes, names, limit }: { changes: ConfigChange[]; names?: ChangeNames; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = limit && !all ? changes.slice(0, limit) : changes;
  return (
    <div>
      <ul className="flex flex-col divide-y divide-line">
        {shown.map((c) => {
          const d = describeChange(c, names);
          return (
            <li key={c.field} className="flex flex-col gap-0.5 py-1.5 text-sm first:pt-0 last:pb-0">
              <span className="text-ink">{d.label}</span>
              <span className="flex min-w-0 items-baseline gap-1.5 text-xs text-ink-2 tabular">
                <span className="max-w-[45%] flex-none truncate" title={d.before}>
                  {d.before}
                </span>
                <span aria-label="changed to" className="flex-none">
                  →
                </span>
                <span className="truncate text-ink" title={d.after}>
                  {d.after}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
      {limit && changes.length > limit && (
        <button className="mt-2 text-xs text-accent hover:underline" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${changes.length}`}
        </button>
      )}
    </div>
  );
}

const ACTION: Record<HistoryEntry["log"][number]["action"], string> = {
  draft_created: "Draft started",
  edited: "Saved",
  published: "Published",
  discarded: "Discarded",
};

/** Every version, newest first: when, by whom (the shared login, or "migration" for seeded versions), and what changed. */
export function HistoryCard({ entries, names, isPending, error }: { entries: HistoryEntry[] | undefined; names?: ChangeNames; isPending: boolean; error: Error | null }) {
  const [shown, setShown] = useState(5);
  return (
    <Card title="Version history">
      {isPending ? (
        <p className="text-sm text-muted">Loading history…</p>
      ) : error ? (
        <ErrorNote>Couldn't load the history. {error.message}</ErrorNote>
      ) : (
        <ol className="flex flex-col gap-4">
          {entries!.slice(0, shown).map((h) => (
            <li key={h.version} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <VersionBadge status={h.status} version={h.version} />
                <span className="text-xs text-muted">
                  {h.status === "published"
                    ? `${formatDate(h.published_at)} · by ${h.published_by ?? "unknown"}`
                    : `started ${formatDate(h.created_at)} · by ${h.created_by ?? "unknown"}`}
                </span>
              </div>
              {h.changes.length > 0 ? (
                <details className="group">
                  <summary className="cursor-pointer text-xs text-ink-2 hover:text-ink">
                    {h.changes.length} {h.changes.length === 1 ? "change" : "changes"} from the version before
                  </summary>
                  <div className="mt-2">
                    <ChangeList changes={h.changes} names={names} limit={8} />
                  </div>
                </details>
              ) : (
                <p className="text-xs text-muted">{h.status === "draft" ? "No changes saved yet." : "First version."}</p>
              )}
              {h.log.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-xs text-muted">
                  {h.log.map((l, i) => (
                    <li key={i}>
                      {ACTION[l.action]} {formatDate(l.changed_at)} by <span className="text-ink-2">{l.changed_by}</span>
                      {l.changes.length > 0 && `: ${l.changes.map((c) => describeChange(c, names).label).join(", ")}`}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      {entries && entries.length > shown && (
        <button className="mt-3 text-xs text-accent hover:underline" onClick={() => setShown(entries.length)}>
          Show all {entries.length} versions
        </button>
      )}
    </Card>
  );
}

/** "Publish <thing> vN?": what moves, what changes, and that it can't be undone. Keep editing is the safe default. */
export function PublishDialog({
  open,
  onClose,
  onConfirm,
  pending,
  error,
  title,
  version,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
  error: Error | null;
  title: string;
  version: number;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="wide"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-autofocus>
            Keep editing
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={pending}>
            {pending ? "Publishing…" : `Publish v${version}`}
          </Button>
        </>
      }
    >
      {children}
      <p>A published version can't be edited. Later changes go in a new draft.</p>
      {error && <ErrorNote>{error.message}</ErrorNote>}
    </Dialog>
  );
}

export function DiscardDialog({
  open,
  onClose,
  onConfirm,
  pending,
  error,
  version,
  liveVersion,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
  error: Error | null;
  version: number;
  liveVersion: number | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Discard draft v${version}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-autofocus>
            Keep draft
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={pending}>
            {pending ? "Discarding…" : "Discard draft"}
          </Button>
        </>
      }
    >
      <p>All changes in this draft are deleted.{liveVersion !== null && ` v${liveVersion} stays live.`} This can't be undone.</p>
      {error && <ErrorNote>{error.message}</ErrorNote>}
    </Dialog>
  );
}

const codeStyle = "font-mono text-[13px]";

/** A list of short lines, read-only. `variant` "code" sets the items as code chips (reason codes, variable names). */
export function ListView({ value, variant = "text", empty = "None" }: { value: string[]; variant?: "text" | "code"; empty?: string }) {
  if (!value.length) return <p className="text-sm text-muted">{empty}</p>;
  if (variant === "code")
    return (
      <ul className="flex flex-wrap gap-1.5 text-sm text-ink">
        {value.map((v, i) => (
          <li key={i} className={`rounded border border-line bg-sunken px-1.5 py-0.5 ${codeStyle}`}>
            {v}
          </li>
        ))}
      </ul>
    );
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-ink">
      {value.map((v, i) => (
        <li key={i}>{v}</li>
      ))}
    </ul>
  );
}

/** The same list, editable: each line in its own field, and a field to add more (Enter adds; codes split on spaces). */
export function ListEditor({
  id,
  label,
  value,
  onChange,
  placeholder,
  variant = "text",
  addLabel = "Add",
}: {
  id: string;
  /** Names each line for screen readers ("Success when 2"). */
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  variant?: "text" | "code";
  addLabel?: string;
}) {
  const [draft, setDraft] = useState("");
  const style = variant === "code" ? codeStyle : "";
  const add = () => {
    const items = draft
      .split(variant === "code" ? /[\s,]+/ : /\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length) onChange([...value, ...items]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {value.map((v, i) => (
            <li key={i} className="flex items-start gap-2">
              {variant === "code" ? (
                <Input aria-label={`${label} ${i + 1}`} className={style} spellCheck={false} autoComplete="off" value={v} onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))} />
              ) : (
                // Grows with its text, so a long criterion wraps instead of being cut off.
                <Textarea
                  aria-label={`${label} ${i + 1}`}
                  rows={1}
                  className="min-h-9 resize-none [field-sizing:content]"
                  value={v}
                  onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
                />
              )}
              <Button variant="ghost" compact aria-label={`Remove ${v || `item ${i + 1}`}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
                <X size={15} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          id={id}
          className={style}
          spellCheck={variant !== "code"}
          autoComplete="off"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" compact onClick={add} disabled={!draft.trim()}>
          <Plus size={15} aria-hidden />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

/** Asks before leaving with unsaved edits: closing the tab, or following a link inside the dashboard. */
export function useUnsavedGuard(unsaved: boolean) {
  useEffect(() => {
    if (!unsaved) return;
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest("a[href^='#']");
      if (link && !window.confirm("Leave without saving? Your unsaved changes to this draft will be lost.")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [unsaved]);
}

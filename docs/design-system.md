# Dashboard design system

The look and the tokens of the audit dashboard (`dashboard/`). Tokens live in `dashboard/src/index.css`;
shared components in `dashboard/src/components/ui.tsx`. Every value below is in that file; change it there and here
together.

## 1. Art direction

A calm, dense, precise work tool. Auditors read one call after another for hours: transcripts, scores, cited
evidence. The screen should disappear behind the call.

- **Colour means something or it isn't there.** The chrome is ink on stone: no brand colour on navigation, cards or
  headers. Colour appears in three places only: status (good / warning / serious / critical, always with an icon
  and a label), the main data element (the score meter, a selected filter, a slider's fill), and the focus ring.
  Under about 1% of the pixels on a screen are coloured.
- **Flat and quiet.** White cards on a stone ground (#f7f7f5), separated by a 1px line. No shadow on anything at rest;
  shadows only on what floats (menus, popovers, dialogs). No gradients, glows, glass or emoji.
- **Type does the hierarchy.** One face, five sizes, three weights. Titles stay small (20–24px); this isn't a landing
  page. Every number uses tabular figures; numbers in tables are right-aligned.
- **Dense, not cramped.** 14px body, 44px rows, 16px card padding. When density changes, change row height, padding
  and type size together.
- **Motion is feedback, not decoration.** 100–200ms, ease-out, on things the user just did (press, focus, an error).
  Nothing animates on page load, and nothing moves with reduced motion turned on.

Reference: the "achromatic ledger" app style (design-taste-frontend, app-screen rules), with our existing palette and
type kept.

## 2. Token layers

Three layers. Each layer only uses the one beneath it.

| Layer | Example | Changes with theme? | Who uses it |
| --- | --- | --- | --- |
| 1. Base values | `--stone-500`, `--blue-500`, `--space-4`, `--radius-panel` | No | Only the meanings layer |
| 2. Meanings | `--surface`, `--ink-muted`, `--accent`, `--critical`, `--focus-ring` | **Yes** (light / dark) | Components and screens |
| 3. Component tokens | `--input-border-focus`, `--button-primary-bg`, `--dialog-shadow` | No (they follow the meanings) | The component they name |

Screens use the meanings through Tailwind (`bg-surface`, `text-muted`, `border-line`, …) and never write a hex value.
Dark mode sets only the meanings layer, in two identical blocks: the system setting (unless the toggle picked light) and
`[data-theme="dark"]` (the toggle).

Token names avoid Tailwind's own theme variables (`--radius-lg`, `--ease-out`, `--shadow-*`, `--text-*`): redefining
those would silently change existing utilities such as `rounded-lg`.

## 3. Base values

### Colour ramps

| Ramp | Steps |
| --- | --- |
| Stone (warm neutral) | 0 `#ffffff` · 50 `#f7f7f5` · 100 `#f1f1ee` · 150 `#eeeeea` · 200 `#e4e4df` · 300 `#c4c4bd` · 400 `#94948c` · 450 `#8f8f88` · 500 `#6b6b65` · 600 `#4a4a45` · 700 `#33332f` · 800 `#222220` · 850 `#1a1a19` · 950 `#121211` |
| Blue (accent) | 100 `#d9e6fa` · 200 `#8db7f5` · 300 `#6ea2f2` · 500 `#2a6fdb` · 600 `#1f5bbd` · 800 `#253552` |
| Green | 100 `#e3f5e3` · 500 `#0ca30c` · 900 `#17301a` |
| Amber | 100 `#fdf1d6` · 400 `#fab219` · 900 `#352a12` |
| Orange | 100 `#fcebe3` · 400 `#ec835a` · 900 `#3a2419` |
| Red | 100 `#f9e2e2` · 400 `#e05252` · 500 `#d03b3b` · 900 `#3b1c1c` |
| Yellow (highlight) | 100 `#fff4cc` · 900 `#3d3517` |

### Type scale

One face, the system UI stack (see §7). Sentence case everywhere, tracking 0.

| Token | Size / line height | Tailwind | Use |
| --- | --- | --- | --- |
| `--text-meta` | 12 / 16 | `text-xs` | Labels, table headers, badges, hints, timestamps |
| `--text-body` | 14 / 20 | `text-sm` | Body, table cells, inputs, buttons, nav |
| `--text-lead` | 16 / 24 | `text-base` | Card titles that lead a page section; transcript turns |
| `--text-title` | 20 / 28 | `text-xl` | Page title, sign-in heading |
| `--text-figure` | 24 / 32 | `text-2xl` | Stat-tile values, the call score |

Weights: 400 (text), 500 (labels, buttons, badges), 600 (titles, figures). No 700.
Figures: `.tabular` (`font-variant-numeric: tabular-nums`) on every number in a table, tile, meter or score.

### Spacing

4px steps, the same base as Tailwind's spacing (`p-4` = 16px): `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 ·
`-6` 24 · `-8` 32 · `-10` 40. Gaps inside a card: 8–12. Between cards: 16. Page gutter: 16 on phones, 24 from `sm` up.

### Radii

| Token | Value | Tailwind | Use |
| --- | --- | --- | --- |
| `--radius-tight` | 4px | `rounded` | Checkboxes, inline marks |
| `--radius-control` | 6px | `rounded-md` | Inputs, buttons, selects, badges |
| `--radius-panel` | 12px | `rounded-xl` | Cards, tiles, dialogs |
| `--radius-pill` | 9999px | `rounded-full` | Meters, status dots |

The study behind the app rules prefers 8px panels; we keep 12px because every existing card uses it.

### Elevation

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| (none) | 1px `--border` | 1px `--border` | Everything at rest: cards, tiles, tables |
| `--elevation-raised` (`shadow-raised`) | 0 1px 2px / 4%, 0 4px 16px / 8% | 30% / 40% | Menus, popovers, tooltips |
| `--elevation-overlay` (`shadow-overlay`) | 0 2px 4px / 4%, 0 16px 48px / 16% | 30% / 60% | Dialogs |

A surface has a border or a shadow, never both, except a dialog, which also gets a border in dark mode where shadows
barely show.

### Motion

| Token | Value | Use |
| --- | --- | --- |
| `--motion-instant` | 100ms | Button press, checkbox tick |
| `--motion-fast` | 150ms | Hover and focus colour, border changes |
| `--motion-base` | 200ms | Popover / menu enter, inline error enter |
| `--motion-slow` | 300ms | Dialog enter |
| `--motion-ease-out` (`ease-snap`) | `cubic-bezier(0.23, 1, 0.32, 1)` | Everything that enters or responds to input |
| `--motion-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Something already on screen moving to a new place |
| `--press-scale` | 0.97 (1 with reduced motion) | `:active` on buttons |

Rules: animate only `transform` and `opacity` (colour and border changes are transitions, not animations). Exits run
faster than entries. Nothing animates on page load or on keyboard repeat. With `prefers-reduced-motion: reduce`, keep
fades and drop movement (no scale, no shake, no slide).

## 4. Meanings

| Token | Tailwind | Light | Dark | What it is for |
| --- | --- | --- | --- | --- |
| `--bg` | `bg-bg` | stone-50 | stone-950 | Page ground |
| `--surface` | `bg-surface` | stone-0 | stone-850 | Cards, tiles, inputs, dialogs |
| `--surface-sunken` | `bg-sunken` | stone-100 | stone-800 | Wells, row hover, secondary hover, empty meters |
| `--border` | `border-line` | stone-200 | stone-700 | Card edges, row rules, dividers |
| `--border-control` | `border-control` | stone-450 | stone-500 | Edges of inputs and secondary buttons (3:1, see §6) |
| `--ink` | `text-ink` | stone-850 | stone-150 | Primary text and figures |
| `--ink-2` | `text-ink-2` | stone-600 | stone-300 | Secondary text: reasons, explanations |
| `--ink-muted` | `text-muted` | stone-500 | stone-400 | Labels, meta, placeholders |
| `--accent` | `bg-accent` / `text-accent` | blue-500 | blue-300 | Main data element, links, selected state |
| `--accent-hover` | `bg-accent-hover` | blue-600 | blue-200 | Hover on accent-filled controls |
| `--accent-ink` | `text-accent-ink` | stone-0 | stone-950 | Text on an accent fill |
| `--accent-track` | `bg-accent-track` | blue-100 | blue-800 | Meter and slider track, selected row |
| `--primary` | `bg-primary` | stone-850 | stone-150 | The one primary action per screen (near-black / near-white) |
| `--primary-hover` | `bg-primary-hover` | stone-700 | stone-0 | Its hover (darker on light, brighter on dark) |
| `--primary-ink` | `text-primary-ink` | stone-0 | stone-950 | Text on it |
| `--highlight` | `bg-highlight` | yellow-100 | yellow-900 | Quoted evidence highlighted in the transcript |
| `--good` / `--good-soft` | `text-good` / `bg-good-soft` | green-500 / green-100 | green-500 / green-900 | Pass, goal achieved |
| `--warning` / `--warning-soft` | | amber-400 / amber-100 | amber-400 / amber-900 | Needs review, goal not achieved, middle scores |
| `--serious` / `--serious-soft` | | orange-400 / orange-100 | orange-400 / orange-900 | Audit failed (service error) |
| `--critical` / `--critical-soft` | | red-500 / red-100 | red-400 / red-900 | Fail, low scores, field errors |
| `--focus-ring` | `outline-focus` | blue-500 | blue-300 | Keyboard focus, 2px with 2px offset |
| `--overlay` | | ink at 40% | black at 60% | Dialog backdrop |

**Status rules (unchanged):** a status colour sits on an icon, a dot, a border or a soft fill, never on text. A badge's
label stays in `--ink`. A field error shows a critical border plus an icon and an ink message. One status mark per row.

## 5. Component tokens

| Component | Tokens | Values |
| --- | --- | --- |
| Card (`Card`) | `--card-bg` `--card-border` `--card-radius` `--card-padding` `--card-header-padding` | surface · border · 12 · 16 · 8×16 (header title 14/600) |
| Stat tile (`StatTile`) | `--tile-bg` `--tile-border` `--tile-radius` `--tile-padding` `--tile-label` `--tile-value` | surface · border · 12 · 12×16 · muted 12 · ink 24/600 tabular |
| Badge (`Badge`) | `--badge-height` `--badge-radius` `--badge-padding-x` `--badge-ink` | 20 · 6 · 6 · ink 12/500; icon 13px in the status colour; soft fill and border from the tone |
| Table row | `--row-height` `--row-border` `--row-hover` `--row-selected` | 44 · border (1px rule, no zebra, no header band) · sunken · accent-track; headers 12px muted sentence case |
| Input / select | `--input-height` (`-compact`) `--input-bg` `--input-border` (`-hover` `-focus` `-error`) `--input-placeholder` `--input-radius` `--input-padding-x` | 36 forms / 32 filter bars · surface · control → muted → accent / critical · muted · 6 · 12; label above, 14/500, 6px gap |
| Button | `--button-height` (`-compact`) `--button-radius` `--button-padding-x`, `--button-primary-*`, `--button-secondary-*`, `--button-ghost-*` | 36 / 32 · 6 · 16 · primary: near-black fill · secondary: surface with control border · ghost: text, sunken on hover; `:active` scale 0.97 over 100ms |
| Slider | `--slider-track` `--slider-fill` `--slider-thumb` `--slider-thumb-border` `--slider-thumb-size` `--slider-track-height` | accent-track · accent · surface · accent · 16 · 4; value printed beside it, tabular |
| Dialog | `--dialog-bg` `--dialog-radius` `--dialog-padding` `--dialog-shadow` `--dialog-backdrop` `--dialog-width` | surface · 12 · 24 · overlay elevation · overlay · 480 max; enters with opacity + scale 0.96 → 1 over 300ms |
| Focus ring | `--focus-ring-width` `--focus-ring-offset` | 2 · 2, `:focus-visible` only |

States, in priority order: disabled (50% opacity, `cursor: not-allowed`, and the reason nearby) → busy (label changes to
the action in progress, e.g. "Signing in…", control disabled) → active (press scale) → focus-visible (ring) → hover
(one step on the fill or border) → default.

## 6. Contrast

WCAG 2.1 AA: 4.5:1 for text, 3:1 for the edges of controls and for meaningful icons.

| Pair | Light | Dark |
| --- | --- | --- |
| ink on surface / bg | 17.3 / 16.1 | 15.0 / 16.1 |
| ink-2 on surface / sunken | 8.9 / 7.9 | 9.9 |
| ink-muted on surface / bg / sunken | 5.4 / 5.0 / 4.7 | 5.7 / 6.1 / 5.2 |
| accent-ink on accent (text on a blue fill) | 4.8 | 7.2 |
| accent as link text on surface / bg | 4.8 / 4.5 | 6.7 |
| primary-ink on primary | 17.3 | 16.1 |
| border-control on surface (input edge) | 3.3 | 3.3 |
| critical on surface (icon, error border) | 4.8 | 4.6 |
| good on surface (icon) | 3.4 | 5.2 |
| warning on surface (icon) | **1.8** | 9.5 |

Known gap: the amber warning icon is 1.8:1 on white. It never carries meaning alone (the badge label says "Needs
review"), so it passes AA, but don't use a bare amber icon or dot without a label.

## 7. Font: keep the system stack

We compared the current stack (`system-ui`: Segoe UI on Windows, San Francisco on macOS, Roboto on Android) with
self-hosting one variable grotesk (Inter was the strongest candidate).

**Verdict: keep the system stack.** It doesn't clearly lose anywhere that matters for this tool:

- Tabular figures: Segoe UI, SF and Roboto all have them, and `.tabular` already switches them on.
- Look: each stack is the platform's own UI face, so the tool looks native and stays sharp at 12–14px with each OS's hinting.
- Cost: no 100–300 KB font download, no flash of fallback text, nothing to licence or update.
- What a custom face would add: the same letter shapes on every OS, and slightly clearer 1 / l / I in IDs. That's real
  but small. Call IDs are numbers, and we don't show codes where l and I could be confused.
- The app-screen rules also flag Inter as the default "kit" face of generated dashboards.

Revisit if screenshots taken on different OSes need to match, or if we start showing mixed-letter IDs (add a mono for
IDs only then, self-hosted).

## 8. Changes to existing values

All existing token names and Tailwind aliases are kept. Three values changed:

| Token | Was | Now | Why |
| --- | --- | --- | --- |
| `--ink-muted` (light) | `#75756e` | `#6b6b65` | Was 4.3:1 on the page ground and 4.1:1 on sunken panels, under AA. Now 5.0 / 4.7. Very slightly darker grey labels. |
| `--critical` (dark) | `#d03b3b` | `#e05252` | Was 3.6:1 on dark surfaces; now 4.6:1. |
| `--ink` (light) | `#1b1b19` | `#1a1a19` | Shares the stone-850 step with the dark surface; not visible. |

New: `--border-control`, `--accent-hover`, `--accent-ink`, `--primary*`, `--focus-ring`, `--overlay`, elevation,
type / space / radius / motion scales and all component tokens.

**One decision for you:** the app rules put the screen's one primary action in near-black (`--primary`), keeping blue
for data only. Today's buttons (*Audit this call*, *Sign in*) are blue (`bg-accent`). The tokens support both; the new
sign-in button would use near-black, and older screens would switch when they're next touched. If you'd rather keep
blue primaries, `--button-primary-bg` points at `--accent` instead and nothing else changes.

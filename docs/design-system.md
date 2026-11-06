# Dashboard design system

The look and the tokens of the audit dashboard (`dashboard/`), following the **Brahmaverse design system**
(`docs/design assets/Brahmaverse-Design-System.pdf`; the System Dashboard mockup is `docs/design assets/00 System
Dashboard@1x.png`). Tokens live in `dashboard/src/index.css`; shared components in `dashboard/src/components/ui.tsx`.
Every value below is in that file; change it there and here together.

## 1. Art direction

A calm, precise work tool in warm greys. Auditors read one call after another; the screen should disappear behind the
call, and a dashboard should show what needs attention at a glance.

- **Warm greys, never pure white or black.** Canvas `#FBFAF8`, surfaces `#FFFEFC`, ink `#0B0B0B`. The chrome is ink on
  warm grey: no brand colour on navigation, cards or headers. The current nav item and the one primary action are ink
  pills.
- **Colour means something or it isn't there.** Status (good / warning / serious / critical, always with an icon and a
  label), chart series, the main data element, and the focus ring. A warm hue only on what needs attention.
- **Soft panels.** Cards rest on a soft tinted shadow and no border (`shadow-card`); what floats (menus, popovers,
  tooltips, dialogs) gets a stronger shadow and a 1px line. A surface has a border or a shadow, never both (dark mode
  draws the card shadow as a 1px ring, since shadows barely show there). No gradients, glows, glass or emoji.
- **Pills for controls.** Buttons, selects, inputs, badges, chips and segmented controls are fully rounded; cards 14px,
  dialogs 20px.
- **Type does the hierarchy.** Inter only, 400 / 500 / 600, hierarchy from size more than weight. Every number uses
  tabular figures; numbers in tables are right-aligned.
- **Motion is feedback, not decoration.** 100–200ms, ease-out, on things the user just did. Nothing animates on page
  load, and nothing moves with reduced motion turned on.

## 2. Token layers

Three layers. Each layer only uses the one beneath it.

| Layer | Example | Changes with theme? | Who uses it |
| --- | --- | --- | --- |
| 1. Base values | `--warm-500`, `--blue-500`, `--space-4`, `--radius-card` | No | Only the meanings layer |
| 2. Meanings | `--surface`, `--ink-muted`, `--accent`, `--critical`, `--series-2`, `--focus-ring` | **Yes** (light / dark) | Components and screens |
| 3. Component tokens | `--input-border-focus`, `--button-primary-bg`, `--card-shadow` | No (they follow the meanings) | The component they name |

Screens use the meanings through Tailwind (`bg-surface`, `text-muted`, `border-line`, `bg-series-1`, …) and never write
a hex value. Dark mode sets only the meanings layer, in two identical blocks: the system setting (unless the toggle
picked light) and `[data-theme="dark"]` (the toggle).

Token names avoid Tailwind's own theme variables except two deliberate ones: `--radius-xl` (14px, cards) and
`--radius-2xl` (20px), so the existing `rounded-xl` cards follow Brahmaverse.

## 3. Base values

### Colour

Brahmaverse values, as named in its file. **Derived** values aren't in the Brahmaverse file: its system has no dark
mode, and WCAG needs a few steps it lacks (control edges ≥ 3:1, secondary text ≥ 4.5:1).

| Ramp | Steps |
| --- | --- |
| Warm grey | 0 `#FFFEFC` surface · 25 `#FBFAF8` canvas · 100 `#EEECEA` fill / line · 200 `#DEDCDA` line strong · 300 `#B7B2AE` offline · 400 `#9F9B99` text 3 · 450 `#8A8683` derived (control edge) · 500 `#615E5C` text 2 · 600 `#45423F` derived · 700 `#2C2A28` derived · 800 `#232120` · 850 `#1B1A19` · 900 `#141312` (derived dark surfaces) · 950 `#0B0B0B` ink |
| Warm grey, dark text (derived) | 100 `#F2F0EE` · 200 `#C9C5C2` · 300 `#A39F9C` · 400 `#75716E` · 500 `#3A3735` |
| Blue | 100 `#DCE9FF` role admin bg · 500 `#1F5FD0` role admin · 300 `#7AA5F0`, 600 `#184DA9`, 900 `#1C2C4A` derived |
| Green | 100 `#DCF4E2` success bg · 400 `#2FA36B` connected · 500 `#178A3A` success fg · 300 `#4CC277`, 600 `#12722E`, 900 `#15301E` derived |
| Amber | 100 `#FDF0D2` guest bg · 400 `#F0A825` pending · 600 `#C98200` guest · 900 `#3A2E12` derived |
| Orange | 100 `#FDE4DA` attention bg · 500 `#E2562A` attention fg · 400 `#F07A55`, 900 `#3D2219` derived |
| Red | 500 `#C81E1E` danger · 100 `#FBE3E3`, 400 `#EF5350`, 900 `#3E1A1A` derived |
| Violet | 500 `#8A4BF0` (agent Astra) · 300 `#A982F5` derived |

### Type scale

Inter 400 / 500 / 600 from Google Fonts (`dashboard/index.html`), system UI stack as the fallback. Sentence case.

| Token | Size / line height | Use |
| --- | --- | --- |
| `--text-meta` | 12 / 18 | Labels, table headers, badges, hints |
| `--text-body` | 14 / 20 | Body, table cells, inputs, buttons, nav |
| `--text-lead` | 16 / 22 | Card titles (500) |
| `--text-title` | 22 / 28 | Page title (500, −0.01em) |
| `--text-figure` | 28 / 34 | KPI values (500, −0.02em, tabular) |

Tailwind's `text-xs` / `text-sm` / `text-base` are used for the first three; the title and figure sizes are written as
`text-[22px]` / `text-[28px]` where they appear. Figures: `.tabular` on every number in a table, tile, chart or score.

### Spacing

4px steps, the same base as Tailwind's spacing: `--space-1` 4 · `-2` 8 · `-3` 12 · `-4` 16 · `-5` 20 · `-6` 24 · `-8`
32 · `-10` 40. Between cards: 20. Card padding: 20. Page gutter: 16 on phones, 32 from `sm` up; max width 1360.

### Radii

| Token | Value | Tailwind | Use |
| --- | --- | --- | --- |
| `--radius-tight` | 6px | `rounded-md` (Tailwind's own) | Chart bars, inline marks |
| `--radius-control` | 12px | | Controls drawn as rounded rectangles (rare) |
| `--radius-card` | 14px | `rounded-xl` | Cards, tiles, popovers |
| `--radius-panel` | 20px | `rounded-2xl` | Dialogs |
| `--radius-pill` | 9999px | `rounded-full` | Buttons, inputs, selects, badges, chips, nav items, segmented controls |

### Elevation

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--elevation-card` (`shadow-card`) | 0 1px 2px / 4%, 0 8px 24px / 5% (ink-tinted) | 1px `--border` ring | Cards and tiles at rest |
| `--elevation-raised` (`shadow-raised`) | 0 4px 12px / 6%, 0 16px 40px / 10% | ring + 0 16px 40px / 50% | Menus, popovers, tooltips |
| `--elevation-overlay` (`shadow-overlay`) | as raised | ring + 0 16px 48px / 60% | Dialogs |
| `--elevation-ink` (`shadow-ink`) | 0 4px 12px −4px / 40% | none | The current nav pill |

### Motion

| Token | Value | Use |
| --- | --- | --- |
| `--motion-instant` | 100ms | Button press |
| `--motion-fast` | 150ms | Hover and focus colour, menu / popover enter |
| `--motion-base` | 200ms | Inline error enter, stale-data dim on the dashboard |
| `--motion-slow` | 300ms | Dialog enter |
| `--motion-highlight` | 1200ms | A jumped-to transcript turn's highlight fading out |
| `--motion-ease-out` (`ease-snap`) | `cubic-bezier(0.23, 1, 0.32, 1)` | Everything that enters or responds to input |
| `--motion-ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` | Something already on screen moving to a new place |
| `--press-scale` | 0.97 (1 with reduced motion) | `:active` on buttons |

Rules: animate only `transform` and `opacity`. Exits run faster than entries. Nothing animates on page load. With
`prefers-reduced-motion: reduce`, keep fades and drop movement. Tooltips appear instantly (no fade).

## 4. Meanings

| Token | Tailwind | Light | Dark | What it is for |
| --- | --- | --- | --- | --- |
| `--bg` | `bg-bg` | warm-25 | warm-900 | Page ground |
| `--surface` | `bg-surface` | warm-0 | warm-850 | Cards, tiles, inputs, dialogs |
| `--surface-sunken` | `bg-sunken` | warm-100 (fill) | warm-800 | Secondary buttons, chips, wells, empty tracks |
| `--selected` | `bg-selected` | fill at 64% | ink at 6% | Row and link hover, selected rows |
| `--border` | `border-line` | warm-100 | warm-700 | Dividers, row rules |
| `--border-strong` | `border-line-strong` | warm-200 | dark-500 | Chart axes, secondary-button hover |
| `--border-control` | `border-control` | warm-450 (derived) | dark-400 | Edges of inputs and selects (3:1) |
| `--ink` | `text-ink` | warm-950 | dark-100 | Primary text and figures |
| `--ink-2` | `text-ink-2` | warm-600 (derived) | dark-200 | Secondary text, tile labels |
| `--ink-muted` | `text-muted` | warm-500 (text 2) | dark-300 | Labels, meta, hints |
| `--ink-faint` | `text-faint` / `bg-faint` | warm-400 (text 3) | dark-400 | Decoration only: secondary bars, dashed outlines. Never text (2.7:1) |
| `--accent` | `text-accent` / `bg-accent` | blue-500 | blue-300 | Links, the score meter, a selected filter |
| `--accent-track` | `bg-accent-track` | blue-100 | blue-900 | Meter and slider track |
| `--primary` | `bg-primary` | ink | dark-100 | The one primary action, the current nav item, tooltips |
| `--primary-hover` / `--primary-ink` | | warm-700 / warm-0 | warm-0 / warm-900 | Its hover; text on it |
| `--highlight` | `bg-highlight` | amber-100 | amber-900 | Quoted evidence in the transcript |
| `--good` / `--good-soft` | `text-good` / `bg-good-soft` | green-500 / green-100 | green-300 / green-900 | Pass, achieved, a good heatmap cell |
| `--good-ink` | `text-good-ink` | green-600 (derived) | green-300 | A good change written as text (KPI delta) |
| `--warning` / `--warning-soft` | | amber-400 / amber-100 | amber-400 / amber-900 | Needs review, small-sample notes, business miss |
| `--serious` / `--serious-soft` | | orange-500 / orange-100 | orange-400 / orange-900 | Attention: bins under the pass threshold, a weak heatmap cell |
| `--critical` / `--critical-soft` | | red-500 / derived | red-400 / red-900 | Fail, a bad change, field errors |
| `--series-1` … `--series-6` | `bg-series-N` | ink, orange-500, blue-500, green-500, violet-500, amber-600 | dark-100 and derived dark steps | Chart series, in this fixed order |
| `--chart-grid` / `--chart-axis` / `--chart-muted` | | warm-100 / warm-200 / warm-400 | warm-700 / dark-500 / dark-400 | Gridlines, axes, secondary series |
| `--focus-ring` | `outline-focus` | ink | dark-100 | Keyboard focus, 2px with 2px offset (Brahmaverse: an ink ring) |

**Status rules:** a status colour sits on an icon, a dot, a border or a soft fill, and text stays in ink. One exception:
a KPI delta is coloured by meaning (`text-good-ink` / `text-critical`), always with a ▲ / ▼ arrow, and grey when the
change is neutral or the base is under 5.

**Chart series order** was checked with the dataviz palette validator (lightness band, chroma, colour-blind separation
of neighbours, contrast) in light and dark: `orange, blue, green, violet, amber` after ink. Keep the order; a filter
never repaints a series.

## 5. Component tokens

| Component | Values |
| --- | --- |
| Card (`Card`), dashboard panel | surface · `shadow-card`, no border · 14 · 20 padding · title 16/500 |
| Stat tile (`StatTile`), KPI strip | surface · `shadow-card` · label 13 ink-2 · value 28/500 tabular; the dashboard's KPI strip is one card split by 1px lines |
| Badge (`Badge`) | pill · 12/500 ink · icon 13px in the status colour · soft fill and border from the tone |
| Table row | 1px rule, no zebra, no header band; hover `--selected`; headers 12px muted |
| Input / select | 40 forms / 32 filter bars · pill · surface with the control edge · 16 side padding |
| Button | 40 / 32 · pill · primary: ink fill · secondary: fill grey, no border, line-strong on hover · ghost: text; `:active` scale 0.97 |
| Tooltip (`Tip`) | ink card (`--primary`), 12/18, max 256px, `shadow-raised`; shows on hover and on keyboard focus of what it wraps |
| Popover (`Popover`) | surface · 14 · line edge · `shadow-raised` · closes on Esc and outside tap; enters with `menu-pop` |
| Empty state (`EmptyState`) | title 14/500 · one muted line on why · the next step if there is one |
| Switch, slider, segmented, dialog | as before, on the new tokens: switch on = ink; segmented = pill track with a pill thumb; dialog radius 20 |

States, in priority order: disabled (32% Brahmaverse / 50–60% here, `cursor: not-allowed`, and the reason nearby) →
busy (label says what's happening) → active (press scale) → focus-visible (ring) → hover (one step on the fill) → default.

## 6. Contrast

WCAG 2.1 AA: 4.5:1 for text, 3:1 for control edges and meaningful icons. Ratios on surface / page ground / fill.

| Pair | Light | Dark |
| --- | --- | --- |
| ink | 19.5 / 18.9 / 16.7 | 15.3 / 16.3 / 14.1 |
| ink-2 | 9.9 / 9.6 / 8.5 | 10.1 / 10.8 / 9.4 |
| ink-muted | 6.4 / 6.2 / 5.5 | 6.6 / 7.1 / 6.1 |
| ink-faint (decoration only) | 2.7 / 2.6 / 2.3 | 3.6 / 3.8 / 3.3 |
| border-control (input edge) | 3.6 / 3.5 / 3.1 | 3.6 / 3.8 / 3.3 |
| accent (links) | 5.8 / 5.6 / 4.9 | 7.0 / 7.5 / 6.5 |
| good (icon) / good-ink (text) | 4.4 / 5.8 | 7.7 |
| critical | 5.7 / 5.5 / 4.9 | 5.0 / 5.3 / 4.6 |
| serious (bars, icons) | 3.7 / 3.6 / 3.2 | 6.3 / 6.7 / 5.8 |
| warning (icon) | **2.0** | 8.6 |

The amber warning icon is 2.0:1 in light mode. It never carries meaning alone (each warning has its label), so it passes
AA; don't use a bare amber icon or dot without a label.

## 7. What changed from the previous system

The previous system (cool "stone" greys, the system font, flat 1px-bordered cards, 6px controls, a blue focus ring)
was replaced by Brahmaverse on 2026-11-06. All token names and Tailwind aliases were kept, so screens changed through
the tokens; the shared components (`Card`, `StatTile`, `Badge`, `Select`, the nav and theme toggle) and the bordered
panels on other pages (`rounded-xl border border-line` → `rounded-xl shadow-card`) changed with it. New: `--selected`,
`--border-strong`, `--ink-faint`, `--good-ink`, the chart series and chart tokens, `--elevation-card`, `--elevation-ink`,
the `Tip`, `Popover` and `EmptyState` components.

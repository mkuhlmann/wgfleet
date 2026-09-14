# UI Design System — "Signal"

The wgfleet UI is built as an **operator terminal console**: a tool for
people who manage WireGuard fleets from a shell, not a generic SaaS admin
panel. Every screen borrows real conventions from terminal emulators — a
window chrome bar, box-drawing rules, bracket-tagged status and actions,
monospace type throughout — rather than rounded cards and a bright accent
on dark grey, which is the generic look this was deliberately built to avoid.

No component library is used. Everything is plain Vue 3 SFCs styled with
Tailwind CSS v4 utility classes, plus a handful of small custom rules in
`src/assets/main.css` for things utilities can't express (scanline texture,
the blinking caret, the repeating box-drawing rule).

## Tokens

Defined in `packages/app/src/assets/main.css` via Tailwind v4's `@theme`
block, which also auto-generates the matching utility classes (`bg-accent`,
`text-muted`, `border-down/40`, etc.):

| Token | Hex | Utility | Use |
|---|---|---|---|
| `--color-bg` | `#0a0d0a` | `bg-bg` | page background |
| `--color-surface` | `#10140f` | `bg-surface` | cards, table head |
| `--color-surface2` | `#161c12` | `bg-surface2` | modals, nested panels, hover state |
| `--color-border` | `#28351f` | `border-border` | all hairlines |
| `--color-text` | `#d7f2c9` | `text-text` | primary text (soft phosphor, not pure white) |
| `--color-muted` | `#6f8f63` | `text-muted` | labels, secondary data |
| `--color-accent` | `#43f18a` | `text-accent` / `bg-accent` | the one accent — links, primary buttons, focus ring |
| `--color-accent-dim` | `#245c3f` | `text-accent-dim` | `>` prompt glyphs, quiet borders, hover states |
| `--color-up` | `#43f18a` | `text-up` | peer/server connected |
| `--color-down` | `#ff6b5e` | `text-down` | peer/server disconnected, destructive actions |
| `--color-unknown` | `#d9a441` | `text-unknown` | peer status never observed |

Font: **JetBrains Mono** everywhere (loaded from Google Fonts in
`index.html`, set as `--font-mono` / `--default-font-family`). There is
deliberately no separate display/body pairing — a single monospace family
*is* the identity, the same way a real terminal only ever has one face.
Weight and letter-spacing carry hierarchy instead of a second typeface.

## Structural motifs

Reuse these rather than inventing new ones — they're what make the app read
as one console instead of a set of unrelated screens:

- **Bracket actions.** Every button renders as `[ label ]` (built into
  `BaseButton`, don't fight it with icon-only buttons). Table/card row
  actions are short lowercase verbs: `edit`, `del`, `qr`, `cfg`.
- **`>` prompt glyph.** Form labels and search inputs are prefixed with
  `<span class="text-accent-dim">&gt;</span>` — it's the one recurring
  "you are here" marker, standing in for the caret in a real shell prompt.
- **`///` section marker.** Page and card titles that introduce a new
  section (`servers`, `peers`) are prefixed with `///` in `text-accent-dim`,
  echoing a terminal banner line. Don't use it on every heading — only
  where it marks a genuine section boundary.
- **`.rule-line`** (in `main.css`) — a repeating box-drawing `─` rule used
  to separate major sections on a page, instead of a plain `<hr>` or margin.
- **Status as text + color, never color alone.** Connection state is a
  bracketed/bordered word (`up` / `down` / `unknown`) in the semantic color,
  not a bare dot — keeps it legible and accessible at a glance.
- **`.caret`** — the blinking terminal cursor (`main.css`), used sparingly
  for loading states (`loading servers... â–ˆ`). Respects
  `prefers-reduced-motion` (falls back to a static, non-blinking caret).
- **`.crt-scanlines`** — the very faint (5% opacity) horizontal scanline
  overlay applied once, at the app root in `App.vue`. Don't reapply it
  per-component; it's a whole-page atmosphere effect, not a decoration.

## Component map

| Component | Role |
|---|---|
| `BaseButton.vue` | bracketed button, variants: `primary` (filled accent), `secondary` (outlined accent-dim), `danger` (outlined down), `ghost` (borderless, for row actions) |
| `BaseCard.vue` | bordered panel with `>`-prefixed title, optional header/footer slots |
| `BaseInput.vue` | terminal-style text input; `clearable` renders a `[x]` |
| `BaseModal.vue` | teleported dialog with `///`-prefixed header and `[x]` close; `width` is `sm`/`md`/`lg` and only the content row scrolls (see "Dialog layout") |
| `DataView.vue` | shared search + `[grid]`/`[table]` toggle used by both server and peer lists |
| `ToastStack.vue` + `composables/useToast.ts` | in-house replacement for PrimeVue's `ToastService` — same `add({ severity, summary, detail, life })` call shape, so call sites didn't need to change beyond the import |

## Dialog layout

`BaseModal` bounds itself to the viewport and lays its header, content and
footer out as three rows, so a dialog taller than the screen scrolls its
*content* while the title and the actions stay put. Two rules follow from
that:

- **Put a form's actions in the `#footer` slot**, not at the bottom of the
  form, so they never scroll out of reach. The submit button is then outside
  the `<form>`, so give the form an id (`useId()`) and the button a matching
  `form` attribute — see `PeerModal.vue`.
- **Reach for `width` before you let a dialog get tall.** A long form reads
  better as two panes (`grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2`)
  at `width="lg"` than as one column that has to scroll. Split the panes on
  a real distinction — `PeerModal` is "what this peer is and what it
  exposes" against "how it reaches the internet" — and divide them with
  `md:border-l md:border-border md:pl-6`, plus a `rule-line md:hidden` at
  the top of the second pane for when they stack.

Below `md` every dialog is one column, so check new markup at a phone width:
`grid-cols-1` and `min-w-0` are what keep a wide `<select>` or a long option
label from setting the row's width and overflowing the dialog sideways.

## What NOT to reach for

- No PrimeVue, no other component library — the whole point of this pass
  was removing that dependency. Build new UI from `Base*` components and
  Tailwind utilities.
- No icon set (the old `@vicons/carbon` icons were dropped). Actions are
  bracketed words, not glyphs — it's more consistent with the terminal
  voice and it's one less dependency. If a genuinely wordless icon is ever
  needed (e.g. a spinner), inline the SVG directly rather than adding an
  icon package.
- No second accent color and no gradients. One accent (`accent`), used
  sparingly — semantic colors (`up`/`down`/`unknown`) are a separate axis
  and don't count against that budget.
- No `rounded-lg`/heavy rounding — corners stay `rounded-sm` (2px) at most,
  in keeping with a terminal window rather than a soft consumer app.

## Extending this later

If a new screen or component is needed: start from the token table above,
reuse `Base*` components before writing new markup, and keep new copy
lowercase and terse in the terminal voice already used across the app
("add peer", not "Add New Peer"). If a genuinely new pattern is required
(e.g. a chart), sketch it in the terminal idiom first — ASCII-style bars,
bracket-tagged values — before reaching for a conventional chart-library
look.

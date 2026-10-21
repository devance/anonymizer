# Design: Devance Anonymiseur

The app looks like devance.ca: same tokens, same type, same shapes, from the Devance design
system ([`devance/design`](https://github.com/devance/design), `@devance/design`, whose
`DESIGN.md` is the shared rulebook; this file is what is specific to the anonymizer). These rules
come from that site plus a pass with the [taste-skill](https://github.com/Leonxlnx/taste-skill)
(`design-taste-frontend`, `high-end-visual-design`, `redesign-existing-projects`,
`minimalist-ui`), applied to an app, not a landing page. Where the two disagree, the site wins:
it keeps the glass top bar, the grain panels, the double bezel and the button with its arrow in a
circle.

The tokens, Geist, the base and the components (`dv-` classes: top bar, buttons, segmented pills,
fields, switch, double bezel, badges, notices, tables, spinner, dialog, grain panel, glass D, D
tile, highlights) come from `@devance/design`, pinned to a tag in `ui/package.json` and loaded
first in `src/main.tsx`; `src/styles.css` holds only what is specific to the app (composer, drop
zones, review, model picker, first launch, lock). A value both apps need changes in
`devance/design` (new tag), never here. Keep these rules when editing; `src/i18n.test.ts` checks
the copy rules that can be checked.

## The idea

The product is a substitution: a real name becomes a believable fake, goes out to an AI, and
comes back. That substitution is the app's one visual motif. It shows on the first screen as
specimens (`Tremblay` turning into `Gagnon` and back), and everywhere else as the highlighted
text of the review, coloured by kind of value. Everything around it is quiet: cool grays, one
accent, a lot of space.

Brand moments are few and deliberate: the rust (or royal blue) grain panel with the glass D at
first launch, the D tile on the lock screen and in the app icon. Working screens stay calm.

## Tokens

From the design system (`@devance/design/tokens.css`). Light is the brand rust on cool slate;
dark is royal blue. One accent per theme.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#f2f3f5` | `#070d3a` | window background (also the native window colour) |
| `--surface` | `#fbfbfc` | `#0e1650` | tiles, cards, the document page |
| `--shell` | `rgba(20,25,34,.035)` | `rgba(255,255,255,.04)` | the outer ring of a double bezel, segmented controls |
| `--text` | `#141922` | `#eef1ff` | all running text |
| `--muted` | `#59616e` | `#a9b2dc` | secondary text only (hints, meta, labels) |
| `--line` | `rgba(20,25,34,.1)` | `rgba(238,241,255,.12)` | hairlines, field borders |
| `--accent` | `#902b1f` | `#a3bbff` | the primary action, links, focus, selection |
| `--accent-soft` | 7 % rust | 12 % blue | selected rows, the "on" state of drop zones |
| `--on-accent` | `#ffffff` | `#070d3a` | text on an accent fill |
| `--ok` / `--warn` / `--danger` | green, amber, red | lighter versions | notices and badges only |
| `--bar` | 74 % of `--bg` | 70 % of `--bg` | the glass top bar |
| `--panel` | rust gradients | blue gradients | grain panels (onboarding, lock) |
| `--ease` | `cubic-bezier(0.16, 1, 0.3, 1)` | | every transition |

Contrast: running text is 15:1 or more on every surface; `--muted` is at least 5:1; text on an
accent fill is 8:1 or more.

### Highlights (kinds of values)

Seven kinds, each a pale tint with a stronger underline in light, a deep tint in dark. Text on a
highlight stays in `--text` (13.9:1 or more in light, 6.3:1 or more in dark). Never lower the
opacity of text inside a highlight.

| Kind | Types | Light | Dark |
| --- | --- | --- | --- |
| person | person | `#dfe6fb` | `#3346b8` |
| address | address, postal code | `#d9eedd` | `#1b6449` |
| contact | email, phone | `#fae6c4` | `#6f4b12` |
| id | SIN, health card, card, bank account, ID | `#ebe0f7` | `#563695` |
| date | date of birth, date, amount | `#f9dfdb` | `#82303f` |
| org | organization | `#d3ecec` | `#125866` |
| other | other | `#e6e8ed` | `#323b74` |

States: skipped = no fill, dashed outline, muted text. Uncertain = dashed amber outline.
Suggested by the AI = dashed green outline (the copy says "dashed green").

## Type

- **Geist** (variable, from the design system, OFL) for the whole interface. Headings weight
  500 with tight tracking (-0.025em to -0.035em); body 400; labels and buttons 500. No 600/700
  except the replacement value inside a highlight.
- Five sizes do the work: 13 (meta, badges at 11.5), 14.5 (body, controls), 18 (section
  titles), 28 (page titles), 44 (first launch only).
- The document being reviewed is set in the system book serif (Iowan Old Style, Charter,
  Georgia) at 16/1.7 so it reads as a page, not as interface. Markdown stays monospace. These
  are the only other faces.
- Numbers that line up (sizes, counts in tables) use `tabular-nums`.
- Sentence case everywhere. No uppercase letter-spaced labels, no eyebrows above titles.

## Shape

- **Anything you click is a pill** (999px): buttons, nav, tabs, chips, single-line fields,
  selects.
- **Labels are 6px**: badges, the kind and status of a document.
- **Tiles are 20px inside a 26px shell** (6px apart: the double bezel). Use the bezel for the
  things that matter on a screen: the composer, drop zones, the document page, the review
  summary, settings groups, the dialog, the lock card. Plain lists sit in a single tile.
- **Panels are 28px** (the grain panels).
- Notices are 14px; the selection popover, which floats, is 18px.

## Components

- **Top bar**: sticky, glass (`--bar` + 18px blur), one hairline under it, 56px high. The
  first 88px are left for the macOS traffic lights (`trafficLightPosition` 18, 30 in
  `tauri.conf.json`) and the whole bar is a `data-tauri-drag-region`. Left: wordmark, product
  name. Then the nav as a segmented pill group (Projets, Restaurer, Réglages). Right: devance.ca
  (link with an arrow), lock, FR/EN, theme. Without transparency (`prefers-reduced-transparency`)
  the bar is opaque.
- **Primary button**: accent pill. With an arrow it is a button in a button: the label, then the
  icon in its own 30px circle flush with the inner edge; the circle moves 2px on hover, the pill
  scales to 0.98 when pressed. One primary per screen.
- **Secondary button**: surface pill with a hairline and a small shadow. **Ghost**: text only,
  shell on hover. **Danger**: red text; a filled red pill only to confirm an erase or a delete.
- **Fields**: pills on `--field`, hairline border, accent border plus a 3px soft ring on focus.
  Textareas sit inside a bezel and have no border of their own.
- **Segmented control** (nav, tabs): a shell pill holding pills; the current one is a surface
  pill with a small shadow.
- **Switch**: 34 x 20, accent when on. Checkboxes are native with `accent-color`.
- **Badges**: 6px, 11.5px, hairline, quiet. Accent badge for "suggested", ok for "in use".
- **Notices**: 14px, an icon, a tinted background, text in the tint's ink. Errors say what to do.
- **Drop zones**: a bezel with an icon in a circle, a title and the formats. On drag-over the core
  turns `--accent-soft` with an accent ring. No dashed borders.
- **Dialog**: native `<dialog>`, a bezel on a blurred, dimmed backdrop; Cancel left of the action.
- **Grain panel**: `--panel` gradients, grain overlay (SVG turbulence, `mix-blend-mode: overlay`),
  a light edge along the top, white ink. The glass D tile sits on it, tilted, and settles once on
  load.
- **Composer** (Home, Restore): a bezel whose core is a borderless textarea. Empty, it shows one
  centred invitation (icon, one line, one line of formats) that disappears as soon as you type;
  the bar under it holds one row: choose a file, then the project and the actions on the right.
- **Specimen**: the substitution shown with real-looking values in the document serif
  (`Tremblay` highlighted as a person, an arrow, `Gagnon` in the accent). Used on the first
  screen; any new explainer should show the product doing its job the same way, not an icon.
- **Review**: the document on a bezel "page" in the serif, highlights by kind; the side column
  holds the one primary action, the legend and the values (real value, then its stand-in, then
  what it is). Selecting text opens a floating popover (the only other shadow in the app).

## Screens

- **First launch**: content left, the grain panel right (44 %, the glass D, the promise at the
  bottom, language and theme as glass chips on the panel). Dots show the step. To pick a model
  the panel narrows to 31 % and the cards go two by two; Ollama and basic mode fold under
  "other choices" unless one of them is in use.
- **Lock**: the backdrop, one bezel card in the middle: the D tile, the title, the field, the
  action, "forgot your password".
- **Working screens**: page head, then content. One primary action per screen, in the accent.

## Layout

- Page width 1200px (760px for single-column pages), 32px gutters, 32px under the bar.
- Page head stacks: a back link when there is a parent, the title, one line of meta or intro.
  Actions sit on the right of the title only when they act on the whole page (delete project).
- Two-column working screens: content `1fr`, side `340px`, 24px gap. The side sticks under the
  bar.
- Space inside a tile: 20 to 28px. Between groups: 24 to 32px. Between a title and its text: 6 to
  10px.
- Works at the minimum window (1024 x 700): nothing scrolls sideways, the side column stays.

## Motion

- `--ease` for everything, 0.2s for colour, 0.3 to 0.6s for movement. Transform and opacity
  only.
- Onboarding steps enter with a 14px rise and a fade, parts staggered by 60ms. The D settles once.
  Dialogs scale in from 0.98. Nothing loops except the spinner while work runs.
- `prefers-reduced-motion: reduce` turns all of it off (the spinner slows to a fade).

## Copy

- French first, natural Québec French (courriel, NAS, déposer a file, « guillemets »). Write
  plain spaces before « : » and inside « »; `t()` turns them into non-breaking spaces. Following
  the OQLF, no space before ? ! ;. English second, same meaning, not a word-for-word copy.
- Short. One label per intent. Buttons say what they do (« Créer la copie anonymisée »).
- No em or en dashes, no " - " as a dash, no exclamation marks, no "Oops".
- The test in `src/i18n.test.ts` checks: same keys in both languages, no dashes, every `t('…')`
  key used in `src` exists.

## Do and don't

Do:
- Keep one accent per theme and use it for the action, links, focus and selection only.
- Put real values in examples (Tremblay, 1842, rue des Érables), never lorem ipsum.
- Keep focus visible: 2px accent outline, 2 to 3px offset, on every control.
- Use Phosphor Light icons through `components/icons.tsx`, which reads the design system's
  `icons/`. Add new ones to `devance/design` (from `@phosphor-icons/core`, light weight only).

Don't:
- No emoji, no gradients outside the grain panels, no glass outside the top bar, no glows.
- No monospace labels, no numbered sections (01, 02), no eyebrow tags, no uppercase micro labels.
- No rows of identical icon cards. No fake dashboards or charts.
- No shadow on things at rest beyond the tile's 1px shadow; real shadows only for what floats
  (dialog, popover, the bar's blur).
- No hard-coded colours in components: tokens only.

## Looking at it

Debug builds can be driven and photographed (see `desktop/e2e/shots.sh`):

```bash
desktop/e2e/shots.sh "$PWD/desktop/e2e/screens.js" "$PWD/desktop/e2e/screens" --keep-data /tmp/anon-screens
desktop/e2e/shots.sh "$PWD/desktop/e2e/screens-lock.js" "$PWD/desktop/e2e/screens" --keep-data /tmp/anon-screens
SHOTS_SIZE=1024x700 desktop/e2e/shots.sh …   # the smallest window
```

`screens.js` walks first launch by clicking, seeds a project in basic mode and visits every
page in both themes (`SCREENS_LANG` at its top switches to English). Look at every picture
before calling a change done; check the smallest window too.

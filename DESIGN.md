---
name: Meeting Copilot
description: A calm dark mint interview companion with source-faithful reading surfaces.
colors:
  primary: "#a7dfc2"
  primary-hover: "#bfecd3"
  primary-ink: "#142c20"
  background: "#12171c"
  surface: "#172029"
  field: "#182028"
  text: "#e8edf1"
  muted: "#b0bdb9"
  border: "#394744"
  button: "#25303a"
  button-hover: "#34414c"
  tab-selected: "#283b33"
  placeholder: "#a5b4ae"
  code-background: "#11191b"
  code-toolbar: "#20312a"
  code-text: "#e3eae6"
  code-label: "#b9cdc3"
  syntax-keyword: "#bce3a7"
  syntax-string: "#edcc9c"
  syntax-number: "#b4c9ed"
  syntax-comment: "#a1b3a9"
  account: "#f5f6f7"
  account-hover: "#dcebe2"
  account-ink: "#15211b"
  error-text: "#ffc4b9"
  error-background: "#39231f"
  error-border: "#6a3c31"
  warning: "#f6c17d"
  protected: "#a1c8b3"
  status-thinking: "#f1d29c"
  status-error: "#f29788"
  status-off: "#71808b"
typography:
  headline:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    letterSpacing: "-0.6px"
  title:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    letterSpacing: "-0.4px"
  body:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "16px"
    lineHeight: 1.65
    letterSpacing: "0px"
  supporting:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "13px"
    lineHeight: 1.6
  label:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0px"
  control:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "13px"
  quiet-control:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "12px"
  caption:
    fontFamily: "Segoe UI, Arial, sans-serif"
    fontSize: "11px"
  code:
    fontFamily: "Consolas, 'Courier New', monospace"
    fontSize: "13px"
    lineHeight: 1.7
  wordmark:
    fontFamily: "Georgia, serif"
    fontSize: "28px"
    lineHeight: 1
rounded:
  inset: "6px"
  control: "8px"
  overlay: "12px"
spacing:
  micro: "4px"
  compact: "6px"
  small: "8px"
  group: "12px"
  inset: "16px"
  field-gap: "18px"
  reading-inset: "20px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.button}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  button-secondary-hover:
    backgroundColor: "{colors.button-hover}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.quiet-control}"
    padding: "6px 0"
  button-account:
    backgroundColor: "{colors.account}"
    textColor: "{colors.account-ink}"
    rounded: "{rounded.control}"
    padding: "13px"
  field:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "11px"
    width: "100%"
  navigation:
    backgroundColor: "{colors.field}"
    rounded: "{rounded.control}"
    padding: "4px"
  navigation-selected:
    backgroundColor: "{colors.tab-selected}"
    textColor: "{colors.primary}"
    rounded: "{rounded.inset}"
    padding: "8px 4px"
  code-card:
    backgroundColor: "{colors.code-background}"
    textColor: "{colors.code-text}"
    typography: "{typography.code}"
    rounded: "{rounded.control}"
  overlay:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.overlay}"
---

# Design System: Meeting Copilot

## Overview

**Creative North Star: "The interview companion"**

Meeting Copilot pairs a quiet Windows-style control surface with a small, original pixel robot. Dark slate surfaces and soft mint accents give setup and reading a shared identity. The personality lives in the companion, the italic wordmark, and direct, reassuring copy; controls remain calm and familiar.

Density changes with the task. Setup groups practical choices into four sections; the overlay gives priority to the answer and its exact code. The companion appears in setup and the empty reading state. Motion stays around that companion or in brief control feedback, leaving streamed answers clear and steady.

**Key Characteristics:**

- Dark slate foundations, one soft mint action accent.
- Familiar native typography with a restrained italic wordmark.
- Source-faithful, selectable code in a dedicated reading surface.
- A pixel companion whose effects stay local and respect reduced motion.
- Visible context controls and reachable keyboard reading tools.

This document records the implemented system, not a new direction. Sources are `src/style.css`, the setup and overlay components, `src/ui`, and the seven reviewed 520×700 browser captures. Browser fixtures establish composition and interaction evidence; they do not certify native protection, global shortcut delivery, real model answers, or the pending 100 interview and 20 bug-interview runs. Format follows the [DESIGN.md specification](https://raw.githubusercontent.com/google-labs-code/design.md/main/docs/spec.md).

## Colors

The palette combines cool dark neutrals with pale mint for action, readiness, selection, and focus. Frontmatter values are normative; the stylesheet's later declarations supersede its earlier muted and border values.

Sidecar tonal ramps are derived swatch previews, not additional implemented palette tokens. Component previews reproduce existing primitives; they are static examples rather than substitutes for the application's React behavior.

### Primary

- **Companion Mint** (`primary`, implemented as `--green`): primary actions, active setup tabs, readiness links, answer labels, focus outlines, the text caret, and selection.
- **Light Mint** (`primary-hover`): primary button hover feedback.
- **Forest Ink** (`primary-ink`): text on mint actions and selected text.
- **Selected Forest** (`tab-selected`): the solid inset behind the active setup tab.

### Neutral

- **Night Slate** (`background`): setup canvas and sticky meeting controls.
- **Reading Slate** (`surface`, implemented as `--surface`): the opaque overlay shell.
- **Field Slate** (`field`): fields and the setup navigation track.
- **Pale Slate** (`text`): principal text and control labels.
- **Soft Sage Gray** (`muted`, implemented as `--muted`): explanatory text, question text, and quiet actions.
- **Sage Divider** (`border`, implemented as `--border`): fields, code cards, and section boundaries.
- **Control Slate** (`button`) and **Raised Slate** (`button-hover`): secondary controls and their hover state.
- **Code Night**, **Code Forest**, **Code Paper**, and **Code Sage** (`code-background`, `code-toolbar`, `code-text`, `code-label`): distinguish code, its toolbar, readable source, and metadata.
- **Account Paper** (`account`), **Account Mist** (`account-hover`), and **Account Ink** (`account-ink`): the existing ChatGPT sign-in action.

Syntax colors distinguish keywords, strings, numbers, and comments inside exact source text. Error colors form a warm inset alert; `warning` marks unavailable share protection and `protected` marks active protection. These are semantic treatments, not additional decorative brand accents.

**The Signal Rule.** Use mint to identify action, current state, and reading structure. Keep secondary explanation in the muted neutral.

## Typography

Segoe UI with Arial and sans-serif fallbacks supplies headings, body text, controls, and shortcut labels. Consolas with Courier New and monospace fallbacks supplies code. Georgia is reserved for the italic overlay wordmark; it is not a second body family.

The hierarchy is compact and readable: the setup headline leads, section titles introduce a task, and answer prose is larger than setup explanation. Code remains monospaced, with exact whitespace and horizontal scrolling.

- **Headline:** setup branding; reduces to the title size at the narrow breakpoint.
- **Title:** setup section headings. The empty-state heading is slightly larger (23px).
- **Body:** suggested answer prose, with generous reading leading.
- **Supporting:** setup introductions, questions, and empty-state explanation. Empty-state prose is bounded to (32ch).
- **Label:** reading section headings; sentence case with no tracking.
- **Control:** base buttons and fields. Compact overlay actions use smaller captions (11px).
- **Caption:** shortcut hints, metadata, and privacy copy; protection metadata uses (10px).
- **Code:** source text with the code token's leading, two-column tab stops, and no prose wrapping.
- **Wordmark:** italic Georgia; preserve its small signature scale.

**The Exact Source Rule.** Syntax styling may separate code visually, but source text, indentation, selection, and copied content must remain faithful.

## Layout

Setup uses one centered column capped at (620px), padding (22px 24px 20px), and a minimum viewport height. The four equal-width setup tabs share a padded track. Panels begin after a section-sized gap. Meeting controls form a sticky bottom region, and shortcuts sit in a wrapping footer. Setup can scroll when configuration is long.

The overlay is a vertical flex shell capped at (694px), with a small outer margin. The answer region can shrink, has a maximum height of (450px), and scrolls independently. Secondary tools are bounded at (160px); attachment details at (92px). The question preview is bounded at (4.5em) and remains focusable and scrollable. Footer actions wrap to remain reachable. The reviewed native-size browser frame is (520×700px).

The spacing vocabulary is practical rather than a rigid mathematical scale: micro and compact gaps join controls; larger insets separate fields, panels, and reading. Reading text uses horizontal insets of (20px); overlay tools use (16px).

At widths up to (420px), setup padding becomes (18px), the setup companion becomes (68px) square, the headline becomes (21px), footer actions take their own full-width row, and context modifier text no longer pushes to the far edge.

**The Reachable Footer Rule.** Long questions, code, attachments, and manual input must scroll within their allocated areas while leaving overlay actions accessible.

## Elevation & Depth

Most depth comes from solid tonal layers and thin dividers. Setup controls sit on the canvas without card shadows. The floating overlay alone has a diffuse structural shadow (`0 8px 25px #0005`). The active setup tab is a solid inset, not a lifted card. Focus uses a mint outline (2px) with an offset (3px), rather than a glow.

Control background and border transitions take (150ms ease-out); the tab indicator moves and resizes in (180ms ease-out). Status pulses are the existing short feedback vocabulary. Reduced motion removes CSS animation and transitions and prevents the companion trail from mounting. The companion ripple has no ambient interval and uses click feedback; neither effect belongs over answers.

## Shapes

Controls and code cards share gently rounded corners through the `control` token. Active tab insets and alerts use the smaller `inset` token; the overlay shell uses the larger `overlay` token and clips its contents. One-pixel borders distinguish fields and code. Circular dots communicate status and audio activity. The pixel robot keeps crisp pixel rendering instead of softened interpolation.

## Components

### Buttons

Primary actions are solid mint with forest text and semibold labels. The setup meeting action spans its column, centers its text, and has a minimum height of (46px). Base secondary buttons have a slate fill, a thin border, and a minimum height of (34px). Compact overlay buttons use reduced padding and heights (26–30px).

Hover changes fill; keyboard focus uses the shared mint outline. Disabled controls keep their form at opacity (.55) and use a not-allowed cursor. Quiet text actions have no fill or border and brighten on hover. The sign-in action is the established pale, full-width account variant.

### Inputs / Fields

Fields use the dark field surface, thin sage border, shared control corners, and a full-width layout. Labels remain outside the field; secondary label explanation moves onto its own line. Mint carets and focus outlines provide continuity with buttons. Placeholder text uses its own readable neutral. Alerts carry explicit error text alongside warm color treatment.

### Navigation

The four setup sections use Space UI wrappers around Base UI tabs. A solid forest indicator follows the selected tab; mint text marks that tab. Focus activates the selected section through the primitive's keyboard behavior, and hidden panels remain mounted. Preserve the tab semantics when extending this navigation.

### Cards / Containers

The overlay shell is the principal floating container. Setup sections use spacing and dividers rather than independent cards. Code is a dedicated inset card with a tinted toolbar, language and streaming metadata, and a copy action. Its source area has padding (14px), scrolls without wrapping long lines, and receives keyboard focus.

### Reading and context tools

Answers pair a smaller, bounded question with larger suggested prose and code. A disclosure exposes reading shortcuts without consuming a permanent large strip. Context controls show explicit screenshot and project actions, attached-source summaries, and removal actions. Compact stroke icons are inline SVG (16px), with round caps and joins.

### Pixel companion

The original asset is `public/art/copilot-pixel.png`. It is decorative and hidden from assistive technology; useful status remains text. Setup uses an (88px) square companion; the empty overlay uses (164px). Componentry supplies the hover trail and Canvas UI supplies the small ripple. Pointer coordinates come from the visible companion; the trail stays non-intercepting, unmounts on leave, and cancels its animation frame. Reduced motion keeps the companion still. Reuse this implemented asset and its local behavior when adding companion moments.

## Do's and Don'ts

### Do:

- **Do** use the later stylesheet declarations as the current muted, border, and surface values.
- **Do** preserve source text, selection, horizontal code scrolling, and exact copying.
- **Do** keep context sharing explicit, visible, and removable.
- **Do** preserve focus outlines, tab semantics, and reduced-motion behavior.
- **Do** verify long-content states within the 520×700 overlay frame.

### Don't:

- **Don't** place companion effects over streamed answer text or code.
- **Don't** turn setup into a collection of independently elevated cards.
- **Don't** use the italic wordmark family for paragraphs or ordinary controls.
- **Don't** allow expanding tools to push the overlay footer outside its height budget.
- **Don't** describe browser fixtures as proof of native protection, global shortcuts, model quality, or completed live interviews.

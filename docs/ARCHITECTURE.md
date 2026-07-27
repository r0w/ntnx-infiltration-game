# Architecture at a glance

Two-sentence version: a Hono HTTP server (Bun + SQLite) loads a content pack at boot, runs a game-agnostic engine that renders stages into pre-parsed `MessageUnit[]`, and a React faux-terminal streams those units char-by-char. Nutanix calls are behind a single `NutanixClient` interface with `mock` / `rest` / `sdk` adapters.

## Boundaries

```
┌──────────────────┐      HTTP (JSON)      ┌──────────────────┐
│   Frontend       │  ───────────────────> │   Server         │
│   React SPA      │                       │   Hono + SQLite  │
│   Faux terminal  │  <─────────────────── │                  │
└──────────────────┘                       │       │          │
                                           │       ▼          │
                                           │   Engine (pure)  │
                                           │       │          │
                                           │       ▼          │
                                           │   NutanixClient  │
                                           │   ┌────┬────┬─┐ │
                                           │   │mock│rest│sdk│
                                           │   └────┴────┴─┘ │
                                           └──────────────────┘
```

## Skip / resume: how the state machine avoids replay

The original Python game had a hard bug: every `advance` walked stages 1→N and silently re-validated every previously-passed stage against the live cluster. Because check functions populated UUIDs (`ProjectUUID`, `VMUUID`, …) as a side-effect, skipping was literally impossible - jumping to stage 20 meant stages 1–19's check functions hadn't run, so the UUIDs were missing.

Our engine:

- `stage_history` records `passed | skipped | failed | disabled` per (session, stage). No replay.
- `session_variables` persists captured inputs (Trigram, Username, …).
- `cluster_cache` persists Nutanix UUIDs keyed by `(entity_kind, logical_name)`.
- `StageRunner.nextStage(session)` returns the next stage where
  ```
  stage.active
    && requires.every(c => session.capabilities.has(c))
    && (impact !== 'destructive' || clusterProfile === 'dedicated')
    && stage.id > currentStage
  ```
  Gated-out stages are recorded with `status='disabled'`.
- `skipTo(stageId)` iterates skipped stages and calls `rehydrate()` (typically a light UUID lookup, not the full interactive check) so `cluster_cache` and `session_variables` are populated without user-facing prompts.

## Two-axis stage gating

| Axis | Source | Effect |
|---|---|---|
| **Technical capabilities** | `capability-probe.ts` at session start | Stage lists `requires: ['NCM','IO',…]` → auto-disabled if cluster lacks them |
| **Impact on cluster** | `cluster-profile.ts`: `CLUSTER_PROFILE` env + IP heuristic | Stages with `"impact":"destructive"` auto-disabled on `shared` profile |

Both emit `status='disabled'` into `stage_history` so operators can audit why something was skipped.

## Content is data, engine is code

A pack is a directory:

```
packs/ntnx-infiltration/
├── pack.json             # manifest (defaultLocale, supportedLocales, stage/locale paths)
├── stages/
│   ├── 002.json          # one JSON per stage, id-ordered; messages are keys
│   └── ...
├── checks/
│   └── index.ts          # exports `checks` record: name → CheckFunction
├── locales/
│   ├── en.json           # flat { key: template } map
│   └── fr.json           # add a language by dropping another file here
└── fixtures.json         # mock-mode responses (gitignored in live packs)
```

The engine never imports the pack. The server loads the pack by path at boot (`GAME_PACK=...`). A stage file carries ordered catalog keys, not inline strings; the runner resolves each key against the requested locale, falling back to `pack.defaultLocale` and then to the key itself (so missing translations show up in-game as the raw key string - a grep-able translator marker).

Adding a language is purely data: drop `locales/<code>.json` with the same keys as `en.json`, add the code to `supportedLocales`, done. No code edits.

A second game on another product is a new `packs/` directory and a different `GAME_PACK` at container boot - no engine changes.

## Wire protocol

Every `MessageUnit` is one of five shapes; the frontend does not parse markup:

```ts
type MessageUnit =
  | { kind: 'text'; text: string; color?: string; styles?: string[] }
  | { kind: 'pause'; ms: number }
  | { kind: 'await-input'; variable: string }
  | { kind: 'clear' }
  | { kind: 'code'; text: string; lang?: string };
```

`color` is the exclusive foreground color for the run (one of `red | green | yellow | blue | cyan | magenta | white | dim | prompt`); `styles` lists cumulative modifiers (`bold`, `dim`) so `<red><bold>x</bold></red>` is carried as `color: 'red', styles: ['bold']`. `code` is opaque - content between `<code lang='…'>` and `</code>` is captured verbatim, never re-parsed, and rendered by the frontend as a `<pre>` with a copy-to-clipboard button. The server-side parser accepts a tiny JSX-like grammar (`{Name}`, `<pause sec='3'/>`, `<input var='X'/>`, `<action name='foo'/>`, `<clear/>`, `<code>`, and the wrapping style tags). See the [README](../README.md#content-markup) for the full vocabulary.

`POST /session/:id/advance` returns `{ units, actions, check?, awaitingVariable?, kind: 'units'|'awaiting-input'|'finished' }`. Input flow:

1. Client POSTs advance. Server renders stage, stops at first `await-input` if present, records render offset in DB.
2. Client renders units (typewriter). When it encounters `await-input`, it shows the input field.
3. Client POSTs `/input {variable, value}`. Server persists the variable, re-renders from the stored offset, either emits more units (next input or check-result) or runs the check and advances.

Between consecutive messages in a stage (and between stages), the engine injects a synthetic `{kind:'text', text:'\n'}` so lines in the JSON map one-to-one to terminal lines under `white-space: pre-wrap`.

## Frontend playback

Units are played **sequentially, one at a time** (Matrix-style), not all in parallel:

- `FauxTerminal` tracks an `activeIdx`. Only items with `idx ≤ activeIdx` are mounted; the one at `activeIdx` is playing; the rest are invisible until their turn.
- `TypewriterText` types chars at `typingSpeedMs` when `isActive`, then calls `onDone` → `activeIdx++`.
- `PauseUnit` sets a timer for `ms`, then `onDone`.
- `InstantLine` / `InstantBlock` (info, check-result, finished) fire `onDone` as soon as they become active.
- `await-input` items just fire `onDone`; the input field renders separately in a block-level wrapper so it always starts on a new line.

The typed text for completed items is kept in state via a `completedRef`, so once an item has finished typing it stays visible when the sequencer moves on.

## Session lifecycle

Creation is anonymous: `POST /api/session { locale? }` returns a `sessionId` stored in `localStorage`. Trigram, PIN and username are captured in-game as regular variables (`<input var='Trigram'/>`, `<input var='PIN'/>`, `<input var='Username'/>` on stages 2, 2, 4 respectively). The DB still has NOT NULL constraints on the legacy `trigram` / `pin_hash` columns, satisfied with placeholders (the session id / empty string) - trivial to loosen if needed later.

Reload:
1. `GET /api/session/:id` - if the server is `awaiting`, response includes `replay: MessageUnit[]` re-rendered up to the awaiting input (the engine's `StageRunner.render` uses the current `session_variables` + `cluster_cache`).
2. Frontend prepends `[resumed at stage N - waiting for X]` info line (`press Enter to continue` when `X` is the `$continue` sentinel used by bare `<input/>`), then streams the replay units (same typewriter sequencer).
3. Input field appears; user submits → normal flow resumes.

If the server replies `409` on advance (we thought we were free but the server says we're still awaiting), the client re-hydrates. If `404` (DB reset), the stale `sessionId` is dropped back to the login screen.

## Dev iteration

`GET /api/pack` lists every stage; `POST /api/session/:id/goto/:stageId` jumps forward or backward, clears `stage_history` from the target, preserves `session_variables` + `cluster_cache`. The frontend's `DevPanel` consumes both for a clickable stage grid, colour-coded by `impact` and capability.

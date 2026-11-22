---
name: game-help
description: Create or review step-by-step help for game stages, including concise instructions, annotated screenshots, numbering, localization, and consistency with the player task. Use for help content and capture planning in NCP or NKP packs, not deployment operations.
---

# Game help

Build a walkthrough players can follow by matching each instruction to the interface. Use the established microsegmentation visual conventions described in [the reference](references/microseg-examples.md). Inspect the actual referenced images before reproducing their style.

## Establish the path

Read the target stage's messages, ordered `help` keys, locale text, check, and relevant act. Confirm the target product version and the intended player path. An act's shortcut is not necessarily the path the player should learn.

Read [game-dialogue](../game-dialogue/SKILL.md) for wording, character voice, copy targets, and translations. Help should primarily explain actions; do not repeat the entire narrative.

Identify discrepancies before drafting: required settings, source/destination direction, automatic defaults, validation criteria, or outdated captures. Do not treat an existing help sequence as correct simply because its visual style is the reference. Do not silently change checks or gameplay to match the help.

## Write each step

- Use a short localized heading such as `<white>Step 1 · Define Policy.</white>`, then a direct action and the matching screenshot when useful.
- Group a small coherent set of actions on one screen. Split when a screen transition or crowded annotations make the sequence hard to follow.
- Keep walkthrough step numbers separate from screenshot callouts. Steps advance across the help; callouts normally restart at 1 on each screenshot.
- If a screenshot has callouts, reference those exact numbers in action order: choose the entity (1), select the category (2), click Apply (3).
- A single obvious action needs a highlight or arrow, not a ceremonial “1”. A verification screenshot may need no annotation.
- Explain expected automatic changes as observations, not actions to perform. Give a clear completion state before returning to the game.
- Put dynamic entry values in the text with the pack's copy/code markup. Do not force players to transcribe a screenshot's example username or IP.
- End with brief, actionable troubleshooting only when helpful. Distinguish a delayed observation from a failed configuration.

## Prepare screenshots

Use real captures of the target interface. Keep enough context to identify the page, column, dialog, and navigation controls. Do not fabricate UI labels, selected states, or outcomes. If the user is supplying new captures, provide a capture list and mark missing images instead of pretending they exist.

Follow the reference style:

- Thin, high-contrast red rectangular outlines around relevant fields, choices, or buttons.
- Red arrows for small or ambiguous targets such as a connector's `+`.
- Red circular badges with white numbers for ordered actions on one capture.
- Place marks beside targets without obscuring labels, entered values, validation messages, or native wizard step numbers.
- Annotate only what the current instruction needs; avoid surrounding every control.

Keep labels readable at normal help-reader size and when zoomed. A native modal backdrop is context, not a reason to blur the active dialog. Remove sensitive or irrelevant personal values without hiding the meaning of the exercise; examples must remain clearly distinct from runtime values.

Describe annotations independently of any editor, model, or screenshot tool. Use the available tooling appropriate to the task; do not add an image-generation dependency to the skill.

## Integrate and verify

Store captures in the pack's `assets/` and reference their exact names with `<image src='...' alt='...'/>`. Follow the existing asset naming convention, but do not assume asset suffixes equal visible step numbers: one step can have multiple images. Keep alt/caption text concise and descriptive; it is visible in the help reader.

Update the stage's ordered `help` keys and supported locales together. Keep callout numbers and action order consistent across languages. Reuse the same screenshot when its UI language is appropriate; translate explanatory text, not resource identifiers. Do not change `helpPenaltySec` or introduce extra input prompts as part of an editorial change.

Check JSON, key references, assets, runtime placeholders, and markup. Inspect the help modal and image zoom when changing its content layout. Verify visually that every number points to the control named in the text and that the final state matches the task. For unavailable live validation, state which version/path still needs confirmation.

Keep scope explicit: capture planning, help editing, and gameplay/check changes are different tasks. Follow the user's authorization for each; writing help does not authorize operating on a player's live resources or deploying the game.

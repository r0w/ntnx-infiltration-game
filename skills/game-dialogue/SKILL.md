---
name: game-dialogue
description: Write, shorten, review, or translate player-facing stage dialogue and step-by-step help for the ntnx-infiltration and NKP game packs, preserving character voice, technical instructions, and game markup. Use for Tank or instructor/operator dialogue, not general documentation or backend-only changes.
---

# Game dialogue

Write dialogue a player can act on after one reading. Keep personality in short connective lines and precision in the instructions.

## Choose the voice and scope

Find the target pack in the working repository. Read its `pack.json`, the affected stage, nearby locale messages, and the relevant check. Inspect the act/help when the task touches the guided path. Resolve the displayed speaker through `pack.json`; a technical `tank` key does not necessarily mean the character Tank.

- For `ntnx-infiltration`, read [Tank](references/tank.md).
- For `nkp-bootcamp`, read [NKP instructor](references/nkp-instructor.md).
- For another operator, derive the voice from that pack and the user's direction. Do not transplant Tank's lore or invent a named persona. Ask only if the missing identity materially affects the writing.

Treat existing text as voice evidence, not proof of technical correctness or an approved style template. Preserve user-approved wording and unrelated refinements when editing. A dialogue request does not authorize changing checks, stage order, deploying, or rewriting the entire pack.

## Keep it short without removing the task

- Prefer one purpose per speech block and one or two short sentences of narrative setup before the action. Treat this as an editing target, not a hard limit on technical instructions.
- Include what to do, exact values, and the observable completion condition. Put parallel settings in a compact list; do not repeat them in prose.
- Use at most one brief joke or character beat in an ordinary task sequence, and only when it adds something. Do not add a congratulation, mission recap, or dramatic transition to every action.
- Cut filler such as “Now let's embark on…”, “As you can see…”, and repeated “Great job!”. No marketing, theatrical hacker monologues, or patronizing failure messages.
- Dialogue carries the essential path and learning purpose. Help carries detailed clicks, screenshots, and troubleshooting. Keep UI waypoints in dialogue when players need them to proceed; do not make help mandatory by hiding requirements there.
- Do not add pauses, Enter prompts, page breaks, or modal interactions just to break up verbose prose. Those affect pacing and control flow.

## Preserve the technical contract

Distinguish actions the player performs, observations they make, and conditions the game actually checks. Do not claim the game verified something it does not inspect. Delayed telemetry is not proof of player error.

Use UI labels supported by the target version's interface, screenshots, or reliable documentation. If a click path is unverified, identify that uncertainty outside the player-facing draft rather than inventing a label. When text and check disagree, surface the mismatch; do not silently weaken the task to match a permissive check.

For generic pre-check narration, use the stage’s `checkMessagePrefix: "sentences.check-"` and localized phrase pool instead of a fixed trailing message. The server chooses at check time and remembers the previous key per session to avoid consecutive repetition. Keep stage-specific narrative outside this pool.

Preserve locale keys, variable spelling/case, commands, addresses, units, protocol direction, and required states. Read the local parser or neighboring validated markup before introducing a tag. Do not paste chat speaker prefixes such as `<tank>` into strings unless that pack's format actually expects them.

Use `<copy>` for values the player must enter at that point, not every highlighted word or incidental account reminder. Use `<copy transform='lowercase'>Charlie</copy>` when the displayed name should retain its capitalization but the entered value must be lowercase. Split separately entered values into separate copy targets (for example, the two endpoints of an IP pool). Highlight consequential actions such as starting a VM sparingly, rather than emphasizing whole paragraphs.

## Translate and review

When making a shared instruction change, update each supported locale of that pack unless the user limits the scope. Inspect the locales directory instead of assuming all packs have five languages. Keep placeholders, identifiers, markup semantics, requirements, and copy targets equivalent. Translate the voice naturally; preserve UI labels when the target interface displays them in English.

Before returning a draft or saving an edit:

1. Read it as the player: can they identify the next action and when to press Enter?
2. Remove any sentence that adds neither an action, necessary explanation, nor a useful character beat.
3. Compare requirements with the check and help, flagging discrepancies outside the dialogue.
4. For file edits, inspect the diff for unrelated lost tweaks; validate JSON, placeholders, tag balance, and referenced assets with existing relevant checks. Run broader tests only if executable behavior changes.

Return the requested draft or concise edit summary. Keep editorial explanations out of the game text. Follow the user's current commit/push/deploy instructions; creating or applying this skill grants no additional deployment authorization.

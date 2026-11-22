# Shared game skills

These instructions live in the repository and can be read by any coding agent.
Ask the agent to read the relevant `SKILL.md`; automatic discovery and command
shortcuts depend on the agent's own configuration.

- [game-dialogue](game-dialogue/SKILL.md): character voice, concise storytelling,
  and localized stage dialogue.
- [game-help](game-help/SKILL.md): accurate walkthroughs, numbered steps,
  highlighted controls, and annotated screenshots.
- [impeccable](impeccable/SKILL.md): frontend design review, accessibility,
  responsive behavior, and UI refinement. See its [provenance](impeccable/UPSTREAM.md).

For this game, preserve the established terminal/Matrix identity when refining
existing screens. Use game-dialogue for operator voices and game-help for the
technical walkthrough; use Impeccable for their presentation and interaction.
Do not assume Tank is the operator in every pack. Keep player-facing changes
consistent across supported locales and verify keyboard focus, Enter/Escape,
image zoom, and narrow-screen readability when changing help dialogs.

Example request: “Read skills/impeccable/SKILL.md and critique the help dialog,
preserving the game's identity.”

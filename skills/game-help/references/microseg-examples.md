# Existing microsegmentation help conventions

Paths below are relative to the repository root. These examples were inspected in the existing NCP pack. They define a presentation reference, not an immutable technical walkthrough.

## Visual examples

- `packs/ntnx-infiltration/assets/stage-018-step-01.png`: Define Policy. Red outlines around name, policy type, and Hitlogs; callouts 1–3 beside them; arrow and callout 4 pointing to Next. The matching `stage-018.help-01` names all four actions in order.
- `packs/ntnx-infiltration/assets/stage-018-step-02.png`: one red rectangle around Add Secured Entity, with no number. The matching help has one action.
- `packs/ntnx-infiltration/assets/stage-019-step-05.png`: a single red arrow identifies the small `+` at the left edge of the secured VM card. No unnecessary badge.
- `packs/ntnx-infiltration/assets/stage-019-step-06.png`: a dialog with three outlined targets and numbered red badges: Traffic Filtering, Add New Protocol-Port / Service, Services. Labels remain readable and the surrounding policy remains visible behind the native modal backdrop.

Annotations are already embedded in these PNGs. They are not dynamically drawn by the help renderer.

## Content and rendering

- `packs/ntnx-infiltration/locales/en.json`: `stage-018.help-*` and `stage-019.help-*` combine short headings, instructions, number references, copyable values, and images.
- `packs/ntnx-infiltration/stages/create-microseg-policy.json` and `allow-ssh-in-microseg.json`: the ordered `help` arrays define the reading order; `helpPenaltySec` is gameplay configuration.
- `packages/frontend/src/HelpBlock.tsx`: the help reader is a modal, images can open a zoom dialog, and image alt text is also displayed as a caption. Highlighting and numbering come from the assets and authored text, not this component.

Read the current checkout before using these examples: filenames and implementation can evolve.

## Technical path versus presentation reference

The old `stage-019-step-*` captures demonstrate annotation style, but some show the former combined SSH/ICMP rule. Do not reuse that logic for the revised walkthrough.

The revised `stage-019-discovered-*` and `stage-019-icmp-*` captures show selecting TCP 22 from the blocked game source, then adding a separate Allow All source limited to ICMP Echo Request type 8/code 0. `stage-019-two-rules.png` shows the final draft in List view. Observing discovered traffic is narrative, not a WebSocket-based check.

These captures were made in a Prism 7.5 editor and discarded without applying changes to the learner policy. Runtime IPs and category names come from the help text; screenshot values are examples. Reconfirm the actual task and target version before reusing this path elsewhere.

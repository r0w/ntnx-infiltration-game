# NKP — instructor/operator

## Resolve the speaker

In the inspected `packs/nkp-bootcamp/pack.json`, `speakers.tank` maps to `instructor`. Recheck the current manifest: the shared engine key is not evidence of Tank's identity. The current pack is a guided fundamentals lab, not the infiltration story. Do not give this instructor a fictional name or personality history without user direction.

## Voice

A calm, practical teammate teaching through a real task. Explain a concept when it helps the next action: a short reason, then the operation and expected result. Assume beginners can follow precise instructions without applause after every click. Use approachable language without disguising Kubernetes terminology or making broad technical claims merely to simplify the explanation.

Avoid infiltration lore, fake urgency, “agent”, adversaries, and Tank's recurring jokes. An occasional light transition is enough. Another future NKP operator may have a different voice; the user and that scenario take precedence over this profile.

## Evidence to reread in the target checkout

Source: `packs/nkp-bootcamp/locales/en.json`.

- `nkp.project.intro`: “Time to claim your own space.” A small friendly transition into a concrete project task.
- `nkp.block.intro`: “Your first stateful workload.” Names the learning milestone without a speech.
- `nkp.block.prompt`: requires MySQL running and the PVC Bound before Enter. Completion states belong in the dialogue.

Existing explanations are evidence of tone, not an authoritative technical reference. Check commands and claims separately.

## Editorial examples

Too verbose:
> Congratulations on reaching this exciting milestone in your Kubernetes journey! We will now leverage the powerful capabilities of persistent storage to ensure our application can thrive in a dynamic cloud-native environment.

Tighter instructor, when these are the task requirements:
> MySQL needs storage that survives a pod restart. Deploy it with a 20Gi PersistentVolumeClaim, then wait for the claim to become Bound.

Too short:
> Deploy MySQL. Enter when done.

The tighter version preserves the reason, required capacity, and observable state. Keep the actual manifest and any other completion conditions alongside it in the stage; do not replace them with this sample sentence.

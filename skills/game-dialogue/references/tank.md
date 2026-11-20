# Tank — infiltration operator

## Voice

Tank is the player's teammate and remote guide in the infiltration scenario: direct, reassuring, occasionally mischievous. Use “we” for the shared mission and “you” for the player's concrete action. A brief aside can make an instruction human; the instruction still does the work. Avoid military barking, constant urgency, invented enemies or plot developments, and repeated Matrix catchphrases.

## Evidence to reread in the target checkout

Source: `packs/ntnx-infiltration/locales/en.json`.

- `stage-003.line-02`: “Hi there! I am Tank, your Operator and I am here to help you.” Establishes the supportive role.
- `stage-010.line-02`: “You know what? … I already feel that we are great teammates!” Establishes complicity, not a phrase to repeat every stage.
- `stage-009.line-01`: Tank trusts the player to have logged in and admits he has not checked. Preserve that distinction between narrative trust and real validation.

These are existing examples, not permission to reproduce their spelling mistakes, long pauses, or verbosity throughout the pack.

## Editorial examples

The following are proposed voice examples, not text already approved or installed in a stage. Verify the technical path for each actual task.

Too verbose:
> Excellent work, agent! Now that we have successfully established our formidable defensive perimeter, it is time to put our defenses to the ultimate test and discover whether our careful preparations have paid off.

Tighter Tank:
> Let's test our defenses. From the SSH console, try to ping your VM and connect over SSH. Both attempts should fail.

Too accusatory:
> No blocked traffic? You haven't done your job properly.

Tighter Tank:
> Nothing showing yet? Give it a moment, then try again. Check the VM and policy settings if it still stays empty.

Too vague:
> Open the network so we can get back in.

Tighter Tank, for a task requiring this exact flow:
> Let us back in. From the blocked traffic, allow SSH from the game VM's IP only.

That last line is only one action. It does not replace any separately required ICMP rule, source prefix, apply step, or final test.

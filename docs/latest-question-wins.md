Confirmed transcript revisions no longer wait for an older `turn/steer`
input's `userMessage` echo. Automatic answers submit one complete question
frame per attempt; intermediate transcript and context revisions remain in
the local watch channel.

When a frame changes, its visible draft is cleared and its subsequent output
is discarded. Confirmation starts a 400 ms stale-work grace period. Further
confirmed revisions do not extend that deadline. Resumed speech retracts
confirmation and the deadline; the partly hidden answer stays invalidated.
Each replacement attempt applies the same rule. An unchanged current frame
retains the normal 120-second generation timeout, including when its input
echo has not arrived.

Replacement requires proof that the obsolete turn terminated. Cleanup drains
the receiver while requesting interruption, waits at most five seconds, and
closes the owned service if terminal proof is unavailable. No replacement
starts after failed cleanup. Replacement threads have no previous inference
history, and their explicit context and literal project references are retained.
The latest frame is sampled again immediately before submission, after thread
preparation. Speech that resumes during cleanup or thread preparation is
coalesced locally until confirmation, using the same bounded 120-second
confirmation deadline rather than extending it on each revision. Cancelled
pre-submission waits retire their prepared thread before registering an event
receiver. Sending thread retirement also has a five-second queue deadline;
failure closes the owned service.

Each stream allows at most three replacements (four generation attempts).
Exhaustion retires the last obsolete turn and reports an error instead of
waiting under its long answer timeout or retrying indefinitely. These limits
are protocol policy parameters and have no topic or expected-answer rules.

The 400 ms limit covers obsolete generation after an acknowledged start has
been observed by the answer task. It is not an end-to-end latency guarantee:
semaphore contention, thread preparation, start acknowledgement, cleanup and
fresh service inference have their own costs. The existing 30-second RPC
timeout and shared stdout dispatch architecture remain. Complete prompts
still include exact code and previous suggestions beyond transcript excerpt
budgets; there is no new full-prompt cap. Removing repeated refinement input
does not establish the provider's compute cost or guarantee an improved p95.

Protocol fixtures cover replacement without an obsolete input echo, a second
correction after replacement, a current inference lasting beyond the stale
grace period, literal-reference preservation, retired-thread output rejection,
and finite-budget exhaustion with terminal cleanup. Compilation and execution
are pending while the unchanged baseline hour and pressure recordings run.
No latency improvement or independent accuracy result is claimed for this
candidate yet.

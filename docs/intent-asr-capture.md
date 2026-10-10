# Collect actual ASR fragments for the learned gate

`capture-intent-asr` collects recorded speech through the production authenticated
Nemotron service, PCM conversion, two-source streaming transport and VAD. It does
not instantiate an answer backend or classifier. Questions and source labels are
not compiled into the collector, and no samples are loaded by the live assistant.

Supply a JSON manifest with `runtime`, `model`, `chunkMs`, optional `gpuName`, and
an `utterances` array. Each utterance supplies `id`, `wave`, `sourceGroup` and
optional `context`. Paths resolve relative to the manifest. Use mono PCM16 WAV at
16 kHz. `sourceGroup` must identify the underlying episode across all related
variants and existing training data, so subsequent splits cannot separate them.
`context` contains only prior conversation, never the current question's answer.
GPU selection uses the production device catalog; it is not tied to an adapter
index. Output must be a new file inside the workspace.

`prepare-intent-asr-manifest.py` can prepare a new workspace directory from one
or more offline source datasets. It writes current utterance text files and a
neutral manifest without copying source intent labels. Related episode variants
share a namespaced source group. Synthesize the text files to WAV before capture.
Freeze group splits and evaluation policy before collecting labels; evaluate
fresh ASR groups independently of epoch, temperature and threshold selection.

Build with `cargo build --example capture-intent-asr` from `src-tauri`. On Windows,
include `src-tauri/target/debug` in the process DLL search path when launching the
example directly. Run the executable with the manifest and a new JSONL output
path. It paces 10 ms audio frames at real time, with the configured Nemotron chunk
size, then sends silent PCM to allow normal endpointing. Each utterance uses fresh
streaming sockets while the GPU service remains loaded.

The JSONL journal records source and asset hashes, acoustic events, exact ASR
segments, and changed text assembled by the production semantic question detector.
Schema 2 records success only after a nonempty ASR final has arrived since the
latest renewed voice activity and no partial remains pending. Nemotron endpoints
independently of the local VAD: its final can precede the VAD tail without another
final ever arriving. Both timestamps remain recorded unchanged. Renewed voice,
including activity covered by an earlier receive-time audio timestamp, requires
a new final. Whisper retains the full VAD endpoint fence. Schema 1 journals retain
the original strict timestamp check. Streaming failures and incomplete journals
cannot become training data.
The owned service shuts down when the collector exits normally; Windows process
job ownership also prevents its child from surviving collector termination.

Run `python scripts/prepare-intent-asr.py --capture CAPTURE --output UNLABELED` to
retain the latest candidate and sample earlier changed candidates at least 250 ms
apart, preserving exact words and source groups. The seeded sampling is offline
and does not change live classifier cadence. The
existing `label-intent-prefixes.mjs` annotates these isolated candidates using
signed-in Luna Fast/low. Its fresh-thread batches never contain two candidates
from the same source group. It sends only current words and previous context,
excluding full source text, future words and source intent labels. Review the
annotations, exclude ambiguous samples, and use `assemble-intent-prefixes.py`
with `--prefixes-only` before supervised training.

`split-intent-asr.py` assembles reviewed fragments with an existing training
corpus according to frozen source roles. It reserves complete fresh evaluation
groups, rejects groups already used by the base or development corpus, and
excludes training text overlaps with development or fresh evaluation. Its output
audit records source identities and excluded overlaps. Fresh evaluation must
remain separate from epoch and temperature selection.

Acceptance/debug builds may use `COPILOT_INTENT_PROFILE` to choose a profile
inside `.local/intent-encoder` for a live experiment without replacing the
default file. The native journal records the selected profile identity. Release
builds ignore this override and retain the default profile.

The v61 check captured six contrastive utterances from two existing training
episodes: 237 ASR/acoustic events and 125 changed candidates. Twelve sampled
fragments received isolated annotations; independent model review excluded two
ambiguous fragments. Of the ten retained fragments, only one was a complete
request. Both the original and v57 profiles missed it at confidence 0.95. These
are correlated diagnostics from previously used training groups, not held-out
accuracy measurements or human ground truth. No new profile was trained or
promoted. Details and identities are in [the evidence](evidence/intent-asr-v61.json).

This utility excludes WASAPI capture, microphone interference, monitor rendering,
answer generation, and full application-state parity. It does not measure time to
the first answer word or prove a latency improvement. The near-instantaneous
end-to-end target remains unmet; broader independent ASR episodes and meaningful
live-service evaluation are still required before enabling the learned gate.

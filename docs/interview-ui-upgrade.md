# Interview UI upgrade

The setup and answer overlay now share the incumbent dark mint identity with an original pixel companion. Setup has four keyboard-accessible sections and persistent meeting controls. Answers separate code from prose, preserve exact source offsets, provide copy controls, and keep their reading area and footer within the native window. The implementation uses adapted Space UI tab primitives, Componentry pixel rendering, and Canvas UI ripple rendering; source notices and licenses are in `THIRD_PARTY_NOTICES.md`.

The user confirmed that both surfaces should feel finished, readable code and source-aware context matter, and future UI work should start directly in code. The design record is in `DESIGN.md` and `.impeccable/design.json`. The original pixel-art prompt is embedded in the PNG and saved beside it.

## Verification

- Production frontend build succeeds; six unit tests and eleven interaction tests pass.
- Seven synthetic browser captures at 520×700 cover all setup sections, the empty overlay, and both ends of a long code answer with attachments and manual input. These are layout evidence, not native AI trials.
- A fresh Impeccable reviewer found a disconnected pointer route in the pixel effect. The fix forwards coordinates from the visible companion while leaving its canvas non-intercepting. The passing test reads nonzero canvas alpha and verifies cleanup on leave and suppression under reduced motion. The reviewer scored that material fix resolved.
- Computer Use verified setup paging and Home in the native app, then shared a synthetic browser fixture through Ctrl+Shift+P. Process detection classified its spoofed VS Code title as a browser and attached a 2880×1800 screenshot; no project was attached.
- Native code horizontal scrolling moved from 0 to 418.86px and back. End reached 1568px, matching 2018px content minus 450px reading height; Home returned to zero. The footer bottom was 694.36px in a 699px native viewport.
- Ctrl+Alt+Left moved the overlay 70 physical pixels on this scaled display. Native affinity readback remained 17, with the overlay always on top and no-activate enabled.

The native UI answer correctly identified the screenshot and spoofed browser title. Its generated helper assumed the boolean attachment flags provided in the application reference; the UI question had not specified field types. Object-shaped native snapshot fixtures therefore passed 2/3, and the original code and mismatch are retained. This acceptance question is excluded from interview accuracy. Its first word was 8.953 seconds and completion 25.102 seconds; one deliberately long UI answer is not a latency distribution.

Raw native evidence is `docs/evidence/interview-ui-native-2026-10-14.json`. The evidence reader is `benchmarks/interviews/native-surface-evidence.mjs`.

## Remaining requested work

The current corpus has 100 distinct regular interviews and 20 distinct bug interviews, with three rounds each. The 75 additional regular tasks have 307 frozen functional fixtures, and the resumable runner passed an excluded native pilot. The first counted checkpoint contains three regular interviews, all three rounds, across browser, VS Code and Explorer context handoffs. All final implementations pass their fixtures and manual contract/complexity review. The median round 2 answer overflowed on an additional Number.MAX_VALUE check; round 3 identified and corrected it. The raw checkpoint and review are in `docs/evidence/interview-counted-first-three-2026-10-14.json` and `interview-counted-first-three-review.md`.

The next counted checkpoint contains nine regular interviews (27 responses), with passing final fixtures, exact source paints and keyboard checks. Final contract and complexity reviews are bound to their actual answer hashes in `docs/evidence/interview-contract-reviews.json`; raw evidence is `interview-counted-through-nine-2026-10-14.json`. Across those 27 responses, median first-word latency is 4.265s (p95 10.128s), and median completion is 11.043s (p95 20.848s). These are an interim distribution, not the requested full result.

The remaining 91 regular and 20 bug interviews, and their contract/diagnosis reviews, remain outstanding at this checkpoint. The older 25-problem report and UI acceptance question do not count toward those 120 interviews. Audio transcription reliability is outside this text-driven evidence. Run `node benchmarks/interviews/summarize.mjs` for current local counts; it separates fixture checks from reviewed contracts and excludes pilots.

# Screen monitoring and text output research

## Current repository status

The new Rust module contains opt-in policy, frame/question deduplication, RAM-only answer records, expiration, and insertion eligibility primitives. It does not yet start a monitor, invoke the AI client, observe live UI Automation events, or insert text. The existing manual screenshot action remains a one-shot meeting attachment and must not be used by a polling loop because that path clears meeting answer jobs.

## Windows text output

TSF exposes insertion interfaces, but `ITfInsertAtSelection::InsertTextAtSelection` requires a TSF edit context and a write-capable edit cookie; it can fail with no document lock, no selection, or a read-only selection ([Microsoft API reference](https://learn.microsoft.com/en-us/windows/win32/api/msctf/nf-msctf-itfinsertatselection-inserttextatselection)). Microsoft describes TSF text services as cooperating with applications through the TSF manager, and edit sessions are requested against a specific context ([TSF architecture](https://learn.microsoft.com/en-us/windows/win32/tsf/architecture), [edit sessions](https://learn.microsoft.com/en-us/windows/win32/tsf/edit-sessions)). Therefore TSF is not a general external process API for inserting into arbitrary focused applications. A real TSF backend would need a registered text service and per-application compatibility testing; it is not implemented here.

## Glorious GMMK 2 96%

Glorious documents QMK support for GMMK 2 and lists the 96% ANSI target as `gmmk/gmmk2/p96/ansi` ([Glorious installation guide](https://www.gloriousgaming.com/blogs/guides-resources/gmmk-2-qmk-installation-guide), [96% product guide](https://www.gloriousgaming.com/en-de/pages/guide-gmmk2-96)). This confirms firmware/keymap compatibility for the documented board variant, not a text insertion channel from this Windows application. A QMK macro or HID keystroke sequence would be keyboard-generated automated input; this project makes no claim that such input is human-originated or undetectable. No keyboard firmware was flashed or tested.

## Safety boundary

Any eventual insertion must stay behind fresh UI Automation evidence that the target is enabled, editable, focused, not a password control, and still belongs to the same foreground window and answer generation. The form submit action must remain user-driven. This patch only provides testable in-memory eligibility logic; it does not authorize unattended typing.

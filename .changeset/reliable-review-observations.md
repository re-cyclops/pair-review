---
"@in-the-loop-labs/pair-review": minor
---

Persist analysis activity with instance ownership, revision and terminal receipts across UI, MCP and delegated execution. Keep cancellation requested until owned child processes acknowledge termination.

Add bounded read-only review/check snapshots, cached review discovery, trusted instruction-file includes and loaded-versus-disk protocol receipts. Bind the local HTTP and WebSocket surfaces to loopback and reject foreign mutation origins.

Keep inbox and inspector reads single-flight by target, reject superseded snapshot/cache writes, and keep default and alternate-host drafts separate. Invalidate observed evidence and discovery on server/database changes without admitting delayed old responses. Refresh the loaded saved-review history in bounded pages without dropping older search results or retaining deleted reviews; failed refreshes preserve the previous complete collection. Preserve hidden selection during filtering and accept PR-number searches with `#`.

Bind persisted GitHub collections to their host/repository and source credentials. Record successful empty queues, retain last-success timestamps on failures, and reject older overlapping account writes. Cached reads never execute credential commands; credential command logs omit command text and failure output. Invalidate browser evidence when an opaque collection observation changes, including during an older read, and clear removed rows from visible counts.

Keep the editor and caret intact when opening or dismissing the command palette. Let the topmost native dialog own Escape, retain context while narrowing to files, and wait for modal close handlers before an explicit command changes the review surface. Opening analysis configuration or final preview does not publish or start analysis.

Preserve exact review-body and comment drafts with acknowledged revision checks and recoverable concurrent-edit conflicts. Use one stored selection for counts, final preview and publication; exclusion does not delete text. Final approval requires an explicitly confirmed host/account/head and manifest, without appended attribution or rewritten prose.

Count unfinished comments consistently with the submission manifest, excluding deleted and inactive text. Include saved review-body/decision intent in draft views and resume commands, while keeping already-submitted body revisions out of unfinished-work counts.

Record submission intent and per-comment remote receipts between batches. Revalidate before writes, preserve unrelated remote drafts, reconcile lost responses read-only, and block blind retries for ambiguous outcomes. Keep intentional headless publishing on the same manifest and receipt path.

Send explicitly confirmed empty review bodies as empty strings, including when replacing an earlier pending summary before approval.

Carry persisted local PR associations through publication preflight. Retire acknowledged published editors without clearing excluded text or newer edits, so completed comments do not remain in draft recovery.

Track explicit human-reviewed revisions separately from opening, file visits and AI completion. Bind viewed marks to diff/context content, merge per-file updates across tabs, and retain legacy marks only as unverified history. Compare against the existing checkout with safe full-diff fallbacks; keep full AI scope and freeze the human baseline in each run receipt.

Label older or unknown finding revisions without changing text or anchors. Keep the analysis-history selector as the single owner of the displayed run, share the PR/local finding loader, and reject superseded responses and deferred renders.

Keep terminal results unread until acknowledged. Deduplicate opt-in browser notification attempts through durable per-run claims, and preserve notification and seen receipts across concurrent executor updates.

Fence activity events by instance as well as database identity. Preserve events received during a snapshot request without relying on wall-clock ordering, so a newly observed run does not disappear when timestamps tie.

Verify an owned pending review's contents after the final identity check, so host content added during that check stays pending instead of being submitted without authorization. Keep the local draft and durable partial receipt. Explain the remaining non-atomic host read/submission race in the final preview.

Check only selected outgoing prose with opt-in Markdown-aware advisory or blocking rules. Bind policy and diagnostics into the exact confirmation manifest, preserve technical literals and uncertainty, and never rewrite text or invoke a model during validation. Keep draft revision labels current after saves.

Capture immutable run protocol receipts, including real default-council settings and per-run/voice overrides. Distinguish loaded configuration, disk drift, historical inputs and outgoing policy without exposing private instructions or commands. Keep trusted instruction includes additive to the existing global file, reject project-supplied paths, and resolve selected Markdown sections and introductions once.

Carry global, repository and request instructions through executable analysis and native council voices. Apply loaded global policy to chat creation and both resume paths while preserving independent chat-provider/model selection.

Keep monitoring analysis after dismissing its progress dialog. Reset completed toolbar state, accept terminal cancellation acknowledgements when events are missed, and prevent delayed status responses or timers from changing a newer run.

Inspect the analysis-history selection through the shared protocol command instead of showing only current server defaults or substituting the latest run.

Separate local-history removal from checkout removal and explicit cancellation. Refuse removal while analysis termination is unconfirmed, chat is active, publication is unresolved, or owned background work has not settled. Preserve shared or dirty checkouts and report per-item bulk failures instead of implicit cancellation or false success.

Keep blocked bulk-removal targets selected across table refreshes and filters, with persistent named results for each attempted review. Do not clear the selection on a transport failure or apply delayed results from an older database context.

Serialize checkout removal with native analysis/import admission, chat activation and pool claims through database-backed checkout reservations. Keep pool refresh exclusive until it settles; never expire an interrupted reservation merely because its owner disappeared or its timestamp is old.

Keep chat ownership until provider termination is acknowledged, including concurrent close requests and failed startup cleanup. Refuse another server's close/resume requests, fence stale bridge events and competing resumptions, and retain failed-close ownership for explicit recovery.

Share visible, wrapping notification styles across the inbox and review pages, announce errors accessibly, and render notification messages and link labels as text rather than executable markup.

Keep hidden panels and closed popovers out of keyboard navigation, restore focus when closing them, and use native modal isolation for analysis configuration. Make its level toggles and unchanged-diff expansion keyboard-operable. Preserve phone headings for assistive technology, enlarge touch targets, honor reduced motion inside diff shadow roots, and correct text, placeholder, badge and syntax contrast in both themes.

Preserve check-run revisions instead of relabeling earlier results as current. Exclude mismatched revisions from counts, required-check evidence and failing-check shortcuts; order queued reruns without relying on absent start timestamps. Distinguish HTTP 429 rate limits and keep incomplete CI visible in uncertainty and attention filters.

Report a delegated analysis outcome as unknown when the CLI loses contact before a terminal database result exists. Include its run ID and avoid recommending a duplicate execution while the original executor may still be running.

Drain owned provider processes on graceful server shutdown and stdio MCP input closure, escalating termination when needed before recording cancellation. Refuse new run admission during shutdown and leave other instances sharing the database untouched.

Refresh imported-result counts in activity events and snapshots without assigning an executor or claiming observed runtime. Derive older imported receipts' counts from their saved results.

Update the chat API reference to use stable draft identities, revision-checked edits, independent inclusion and explicit text deletion. Explain conflict preservation instead of teaching revisionless updates that the API rejects.

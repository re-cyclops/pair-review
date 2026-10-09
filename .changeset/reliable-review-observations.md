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

Verify an owned pending review's contents after the final identity check, so host content added during that check stays pending instead of being submitted without authorization. Keep the local draft and durable partial receipt. Explain the remaining non-atomic host read/submission race in the final preview.

---
"@in-the-loop-labs/pair-review": patch
---

Simplify the review inbox and workbench around inspecting findings and submitting a deliberate review. Collapse secondary filters, request history details, row utilities, revision bookkeeping, and submission options behind labelled disclosures; keep active filter counts, analysis/model evidence, CI warnings, drafts, and next actions visible. Move header utilities into a keyboard-accessible Tools popover and server shutdown into the existing command palette. Preserve selection while opening row details, restore the mobile PR title, compact tablet inbox rows and mobile diff controls, and use flat controls with native system typography. Add explicit recovery actions for no-match searches.

Keep submission actions outside the authoring scrollport, with compact phone decisions. Reconcile visible inclusion/counts with the shared draft store, clear stale unsaved feedback after clean undo, and reject preview/publication when visible choices disagree with saved payloads. Preserve explicit fast submission for unchanged visible intent, without checking the human preview confirmation or silently repairing anchors. Changed target/account/head/scope and an already-open exact preview require the existing inspect-and-confirm path.

Remove the concealed decision dropdown from keyboard and screen-reader navigation; the visible decision cards are the only interactive choice. Put exact outgoing summary/comment text beside final confirmation, with editor jump actions. Tighten inbox rows, provide compact mobile activity labels with full accessible context, and update Getting Started for the inbox/findings/submission workflow.

Keep keyboard-focused preview confirmation and publication controls visible even when outgoing text is taller than the dialog.

Keep the newest analysis selected when runs finish within the same second, using insertion order instead of random run IDs to break timestamp ties.

Reject authorization when the saved review decision differs from the visible decision cards. Remove stale submission controls while reopening drafts and ignore submit/preview shortcuts until authoring is loaded. Keep excluded-card styling synchronized with inclusion without dimming readable text or active controls.

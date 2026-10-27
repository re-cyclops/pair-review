---
"@in-the-loop-labs/pair-review": patch
---

Complete quick approvals without waiting on background refreshes; lock overlapping actions and reveal actionable errors. Keep acknowledged submissions durable when local cleanup fails, prevent another approval until cleanup finishes, and recover locally without host credentials or duplicate host writes. Bound each GitHub request to 60 seconds while preserving caller cancellation and uncertain-write reconciliation.

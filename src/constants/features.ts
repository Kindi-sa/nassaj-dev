/**
 * Feature flags (compile-time).
 *
 * TASKMASTER_ENABLED
 * ------------------
 * Master switch for the TaskMaster integration UI (Tasks settings tab,
 * sidebar TaskIndicator, Tasks main tab/panel, NextTask banners, command
 * palette entry). The integration code is intentionally KEPT in the tree —
 * an upstream sync branch (chore/sync-upstream-v1.33) is in flight and
 * deleting the code would complicate the merge. Flip back to `true` to
 * restore the full TaskMaster experience.
 */
export const TASKMASTER_ENABLED = false;

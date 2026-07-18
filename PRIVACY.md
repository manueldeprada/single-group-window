# Privacy policy for Single-group window

Last updated: July 18, 2026

Single-group window collects nothing.

## Data collected

None. The extension has no network code, contacts no server, and includes no
analytics, telemetry, or error reporting.

## What the extension accesses, and why

- **Tab and tab group structure.** The number of tab groups in a window, which
  tabs belong to them, and whether tabs are pinned. Used to decide whether a
  window consists of exactly one group. Tab URLs are not read.
- **Tab group titles.** Read so the group's name can be shown in the window
  title.
- **The active tab's `document.title`.** Read and written, in order to add and
  remove the `[Group name]` prefix. No other part of any page is read.

All of this stays in the browser and is used only to produce the behavior
described. None of it is stored beyond the current session, transmitted, or
shared with anyone.

## Broad host permission

The extension requests access to all sites. This is not because it inspects
pages. Chrome derives a window's title from the active tab's `document.title`,
so changing the window title requires script access to whichever page happens to
be in front, and that page cannot be known ahead of time.

## Local storage

Two things are stored locally, using Chrome's extension storage:

- Whether the title prefix feature is toggled on. Persists until changed.
- The id of the tab currently carrying a title prefix, so the prefix can be
  removed reliably. Cleared when the browser closes.

Neither leaves the device. Uninstalling the extension removes both.

## Contact

manueldeprada@gmail.com

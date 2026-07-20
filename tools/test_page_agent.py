"""Extract pageAgent() from background.js and exercise it under a fake DOM.

    python3 tools/test_page_agent.py

The page agent is the piece that cannot be unit tested inside Chrome without a
live browser, and it is where the prefix-stacking bug lived, so it gets a
harness. Everything else in background.js is Chrome API orchestration.
"""

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = open(f"{ROOT}/extension/background.js").read()

match = re.search(r"^function pageAgent\(.*?^\}$", SRC, re.S | re.M)
if not match:
    sys.exit("could not find pageAgent() in extension/background.js")

HARNESS = (
    match.group(0)
    + r"""

// ---- fake DOM -------------------------------------------------------------
// Models browser behavior pinned down by experiment in the PDF viewer:
//   - The visible TAB title and document.title are separate. The viewer sets
//     the tab directly (viewerSetsTab) without touching document.title, so the
//     two can disagree.
//   - A document.title assignment counts as a change (propagates to the tab,
//     fires the observer) only when its trimmed value differs from the previous
//     document.title. Re-writing the same value, or a whitespace-only edit, is
//     ignored, even when the tab is currently showing something else.
// The observer fires synchronously here; the real one is a microtask, but sync
// is stricter, since a reentrant write shows up as a hang instead of passing.
const norm = (t) => (t ?? "").trim();
let observers = [];
globalThis.MutationObserver = class {
  constructor(cb) { this.cb = cb; observers.push(this); }
  observe() { this.on = true; }
  disconnect() { this.on = false; }
};

let depth = 0;
const doc = {
  head: {},
  contentType: "text/html",
  _doc: "", // document.title backing store
  _last: "", // last document.title value the browser propagated (change baseline)
  _tab: "", // the visible tab title
  get title() { return this._doc; },
  set title(v) {
    this._doc = v;
    if (norm(v) === norm(this._last)) return; // browser ignores a non-change
    this._last = v;
    this._tab = v; // a real change propagates to the tab
    if (++depth > 50) throw new Error("runaway title writes");
    for (const o of observers) if (o.on) o.cb();
    depth--;
  },
};
globalThis.document = doc;

function reset(title) {
  globalThis.window = {};
  observers = [];
  doc._doc = doc._last = doc._tab = title;
}
function pageSets(title) { doc.title = title; } // a page retitling itself
function viewerSetsTab(title) { doc._tab = title; } // PDF viewer: tab only
function tab() { return doc._tab; }

let failed = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "pass" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
}

// ---- the reported bug -----------------------------------------------------
// Apply a prefix, destroy the page-side state the way an extension reload does
// while leaving the text on the title, then apply a renamed prefix.
reset("Wikipedia");
pageAgent("[Old] ", "");
check("prefix applied", doc.title, "[Old] Wikipedia");

globalThis.window = {}; observers = [];   // extension reloaded, title untouched
pageAgent("[R] ", "[Old] ");
check("reload then rename does not stack", doc.title, "[R] Wikipedia");

globalThis.window = {}; observers = [];
pageAgent("[Re] ", "[R] ");
globalThis.window = {}; observers = [];
pageAgent("[Research] ", "[Re] ");
check("three reload+rename cycles stay clean", doc.title, "[Research] Wikipedia");

// Without a stale hint there is nothing to strip, so the old text is now part
// of the base. Documents the limit of the recovery rather than hiding it.
globalThis.window = {}; observers = [];
pageAgent("[X] ", "");
check("no stale hint means no recovery", doc.title, "[X] [Research] Wikipedia");

// ---- page reload ----------------------------------------------------------
// The document is replaced, so the agent is gone and the title is the page's
// own again. The stale hint now matches nothing and must not corrupt the base.
reset("Wikipedia");
pageAgent("[Research] ", "");
reset("Wikipedia");                       // reload: new document, fresh title
pageAgent("[Research] ", "[Research] ");
check("reload reapplies prefix exactly once", doc.title, "[Research] Wikipedia");
pageAgent("", "");
check("reload then remove restores", doc.title, "Wikipedia");

// ---- renaming within one session ------------------------------------------
reset("Wikipedia");
for (const p of ["[R] ", "[Re] ", "[Res] ", "[Research] "]) pageAgent(p, "");
check("keystroke renames do not stack", doc.title, "[Research] Wikipedia");

// ---- the page fighting back -----------------------------------------------
reset("Wikipedia");
pageAgent("[Research] ", "");
pageSets("Wikipedia, the free encyclopedia");
check("page retitle keeps prefix", doc.title, "[Research] Wikipedia, the free encyclopedia");

pageSets("(3) Wikipedia");
check("unread counter keeps prefix", doc.title, "[Research] (3) Wikipedia");

// ---- removal ---------------------------------------------------------------
pageAgent("", "");
check("empty prefix restores page title", doc.title, "(3) Wikipedia");

reset("Wikipedia");
pageAgent("[Research] ", "");
pageAgent("", "");
check("restores after a single apply", doc.title, "Wikipedia");

// ---- PDF viewer: the tab title set out of band -----------------------------
// The viewer sets the TAB title from file metadata, not document.title, and the
// browser treats re-writing document.title's current value as a no-op. Together
// that is the local-file bug: once the viewer desyncs the tab, the target title
// is already in document.title, so a plain re-write cannot push it to the tab.

// First apply on load, document.title and tab still agree.
reset("_ICLR.pdf");
pageAgent("[vesteinn] ", "", "_ICLR.pdf");
check("pdf first apply reaches the tab", tab(), "[vesteinn] _ICLR.pdf");

// The viewer re-asserts the bare filename on the TAB only; document.title keeps
// the prefix, so the group name vanishes from the tab.
viewerSetsTab("_ICLR.pdf");
check("viewer can desync the tab", tab(), "_ICLR.pdf");
check("document.title still holds the prefix", doc.title, "[vesteinn] _ICLR.pdf");

// The settle loop re-injects with the real tab title. document.title already
// equals the target, so recovery must nudge through the bare base. Every earlier
// version got this case wrong.
pageAgent("[vesteinn] ", "", "_ICLR.pdf");
check("desync recovered on the tab", tab(), "[vesteinn] _ICLR.pdf");

// A viewer metadata name that differs from the filename is adopted on the tab.
reset("annual-report.pdf");
pageAgent("[Research] ", "", "annual-report.pdf");
viewerSetsTab("Annual Report 2025");
pageAgent("[Research] ", "", "Annual Report 2025");
check("metadata name adopted on the tab", tab(), "[Research] Annual Report 2025");

// Removing the prefix restores the bare name on the tab.
pageAgent("", "", "[Research] Annual Report 2025");
check("prefix removal reaches the tab", tab(), "Annual Report 2025");

// ---- titles that look like prefixes ---------------------------------------
reset("[Draft] Design doc");
pageAgent("[Research] ", "");
check("bracketed page title is not eaten", doc.title, "[Research] [Draft] Design doc");
pageAgent("", "");
check("bracketed page title restores intact", doc.title, "[Draft] Design doc");

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
"""
)

proc = subprocess.run(
    ["node", "--input-type=module", "-e", HARNESS], capture_output=True, text=True
)
print(proc.stdout + proc.stderr, end="")
sys.exit(proc.returncode)

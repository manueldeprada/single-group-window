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
// The real observer fires on a microtask; firing synchronously is stricter,
// since a reentrant write would show up as a hang rather than pass silently.
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
  _t: "",
  get title() { return this._t; },
  set title(v) {
    this._t = v;
    if (++depth > 50) throw new Error("runaway title writes");
    for (const o of observers) if (o.on) o.cb();
    depth--;
  },
};
globalThis.document = doc;

function reset(title) { globalThis.window = {}; observers = []; doc._t = title; }
function pageSets(title) { doc._t = title; for (const o of observers) if (o.on) o.cb(); }

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

// ---- a retitle the observer cannot see -------------------------------------
// Chrome's PDF viewer sets the title from file metadata after the page loads,
// without a <title> mutation, so the agent never hears about it. Assigning to
// doc._t writes the backing field directly, firing no observer, which is what
// that looks like from inside the page. Re-injecting has to re-read the title
// instead of trusting the base it captured while the document was still empty.
reset("");
pageAgent("[Research] ", ""); // injected mid-load, title still empty
doc._t = "annual-report.pdf"; // the viewer writes; no callback fires
pageAgent("[Research] ", ""); // service worker spotted the divergence
check("silent retitle recovered", doc.title, "[Research] annual-report.pdf");

pageAgent("", "");
check("silent retitle unwinds cleanly", doc.title, "annual-report.pdf");

// The same divergence on the strip path: a prefix must come off even when the
// agent's cached base is stale, or it strands on an inactive tab.
reset("report.pdf");
pageAgent("[Research] ", "");
doc._t = "[Research] renamed.pdf"; // silent retitle, prefix still present
pageAgent("", "");
check("strip survives a silent retitle", doc.title, "renamed.pdf");

// ---- a tab title the document never sees -----------------------------------
// Chrome's PDF viewer sets the *tab* title from the file's metadata without
// touching document.title, so the document keeps the filename while the user
// sees "Annual Report 2025". Building on document.title discards the real name.
reset("annual-report.pdf");
pageAgent("[Research] ", "", "annual-report.pdf");
check("pdf first apply", doc.title, "[Research] annual-report.pdf");

// The viewer's metadata write: tab title only, document.title untouched.
pageAgent("[Research] ", "", "Annual Report 2025");
check("metadata name adopted", doc.title, "[Research] Annual Report 2025");

pageAgent("", "", "[Research] Annual Report 2025");
check("metadata name survives strip", doc.title, "Annual Report 2025");

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

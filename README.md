# Single-group window

A Chrome extension. When a window contains exactly one tab group and no
ungrouped tabs, that window becomes the group's window:

1. **New tabs join the group.** Omnibox tabs, `Cmd/Ctrl+T`, and bookmark opens
   are added to the group instead of landing beside it.
2. **The window title carries the group name.** The active tab's title is
   prefixed, so the window reads `[Research] Wikipedia`. Chrome derives window
   titles from the active tab, so this is what makes the window identifiable in
   Mission Control, the taskbar, and the window switcher.

Drag any tab out of the group and the window stops qualifying, which disables
both behaviors. Drag it back and they resume. That is the entire interface.

The toolbar button toggles the title half independently, which is worth doing
before bookmarking, since Chrome prefills bookmark names from the page title.

## Layout

```
extension/             the loadable extension, and the only thing that ships
  manifest.json        MV3 manifest
  background.js        service worker: grouping, title orchestration, toggle
  icons/               generated, do not edit by hand
tools/make_icons.py    regenerates extension/icons/ and the store promo tile
tools/test_page_agent.py  fake-DOM tests for the injected title agent
build.sh               produces dist/single-group-window-<version>.zip
store/                 Web Store listing copy and graphics, untracked
dist/                  built upload zips, untracked
```

## Developing

Load unpacked from `chrome://extensions` with Developer mode on, selecting the
`extension/` subdirectory, not the repo root. Chrome records the absolute path,
so moving this directory breaks the install.

After editing `background.js`, hit reload on the extension card. Pages that
already carry a title prefix keep the old injected agent until reloaded. The
**service worker** link on the card opens DevTools for the background script,
which is where errors swallowed by the `catch` blocks would otherwise vanish.

## Known limits

- `chrome://` pages, the New Tab Page, and the Web Store reject script
  injection, so they show no prefix.
- PDFs work, but arrive late. Chrome's viewer sets the tab title from file
  metadata after the page finishes loading, without a `<title>` mutation the
  page agent can observe, so the service worker has to notice the prefix went
  missing and put it back. Expect a brief moment on load where the filename
  shows unprefixed.
- Bookmarks and history entries created while a prefix is applied inherit it.
- Disabling or reloading the extension leaves the prefix visible on any tab that
  has one until the extension runs again or the tab is reloaded. The prefix is
  recorded in `storage.local`, so the next run strips exactly what it wrote
  rather than absorbing it into the title. Clearing extension storage while a
  prefix is applied loses that record, and the leftover text becomes part of the
  title until the tab reloads.
- Requires Chrome 102 or newer. That is a conservative floor rather than a
  measured one; every API in use predates it.

## Testing

```
python3 tools/test_page_agent.py
```

Exercises `pageAgent()` against a fake DOM: rename sequences, reload-then-rename
(which used to stack prefixes), pages that retitle themselves, and page titles
that already start with a bracket. The rest of `background.js` is Chrome API
orchestration and has to be checked in a browser.

## Publishing

Run `./build.sh` to produce the upload zip in `dist/`. The Web Store listing
copy lives in `store/listing.md`, which is kept out of git along with the built
zips; `tools/make_icons.py` regenerates the icons and the promo tile.

## License

MIT, see `LICENSE`.

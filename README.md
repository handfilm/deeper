# RAWX MOTION LAB — Desktop Gallery

A brutalist, multi-window "desktop OS" gallery. Categories and tags come
straight from your Google Drive folder structure — no manifest file, no
build step, no filename convention required.

## Drive folder structure

```
ROOT FOLDER                <- put its ID in app.js: CONFIG.driveRootFolderId
 ├─ Signature/              <- becomes a category tab
 │   ├─ Back Studies/       <- becomes a tag inside that category's windows
 │   │   ├─ clip-01.mp4
 │   │   └─ shot-02.jpg
 │   └─ Lingerie Dynamics/
 │       └─ ...
 ├─ Core/
 │   └─ Merch/
 │       └─ ...
 ├─ Hook/
 └─ Elegance/
```

- **Category folder name** → tab in the top bar, and the title of any
  window opened for it.
- **Tag subfolder name** → the chip/card shown when you open a category,
  and the label on every asset inside it.
- Filenames can be anything — the display title is just the filename,
  title-cased, extension stripped. The old `<kind>-<slug>.ext` naming
  convention is no longer required.

## One-time setup

1. In Google Cloud Console, enable the **Google Drive API** and create an
   API key (restrict it to your GitHub Pages domain via HTTP referrer
   restriction).
2. Share the **root** folder as "Anyone with the link — Viewer". Sharing
   cascades to every subfolder inside it, so you don't need to share each
   category/tag folder individually.
3. Open `app.js` and set:
   ```js
   var CONFIG = {
     driveRootFolderId: 'YOUR_ROOT_FOLDER_ID',
     driveApiKey: 'YOUR_API_KEY',
     pageSize: 60   // files fetched per page inside a tag folder
   };
   ```
   The folder ID is the last segment of the folder's Drive URL:
   `drive.google.com/drive/folders/`**`THIS_PART`**

No Apps Script is used anywhere — this is a pure client-side call to the
public Drive REST API using the API key above.

## How loading works (built for very large libraries)

Nothing is fetched recursively up front. At boot, only the category
folders are listed (cheap — usually just a handful). Tag subfolders are
listed the moment you open a category window. Files inside a tag are
fetched a page at a time (`pageSize`, default 60) and more are pulled in
automatically as you scroll or hit "load more" — so a library with
thousands of files loads instantly instead of hanging on one giant
request.

## The desktop shell

- **Top bar** — category tabs. Click one to open (or refocus) a window
  for that category.
- **Desktop** — floating windows. Drag by the title bar, resize from the
  bottom-right corner, minimize / maximize / close with the title-bar
  buttons. Open as many category windows side by side as you want.
- **Taskbar** — every open window gets a button here; click to
  focus/minimize/restore. "+ NEW WINDOW" opens the same category picker
  as the top tabs. The Board button opens your pinned-assets sourcing
  board (works the same as before — pin from any window, submit a B2B
  inquiry).
- Inside a window: pick a tag → search / sort / grid density (S/M/L) →
  click any asset to open the shared lightbox (arrow keys / F for
  fullscreen / Esc to close).

## Files

- `index.html` — desktop shell markup (top bar, taskbar, lightbox, board
  modal). Windows themselves are built entirely by `app.js`.
- `desktop.css` — window manager, top bar, taskbar, tag picker, per-window
  grid styling.
- `style.css` — base brutalist design system (fonts, colors, lightbox,
  modal, buttons) — shared, mostly unchanged.
- `app.js` — everything: lazy Drive fetching/caching, window manager
  (drag/resize/focus/minimize), gallery rendering, pin board, lightbox.
- `generate-manifest.js` — kept for reference only; not used by the
  current Drive-driven build.

## Next steps you can build on top of this

- Right-click context menu on asset cards (open, pin, copy link)
- Drag-and-drop assets between windows onto the Board
- A "search across all open windows" bar in the top bar
- Persist window positions/sizes to `localStorage` between visits

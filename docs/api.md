# The Paperly extension API

What a Paperly extension is, what Paperly gives it, and what stays stable.

## An extension

An extension is an `.xpi`: a ZIP with a `manifest.json` and a `bootstrap.js`
at its root, the same format as a Zotero 7+ plugin (Paperly is built on
Zotero). [`template/`](../template) is a complete one.

Paperly runs `bootstrap.js` in a sandbox of its own and calls these functions,
each with `({ id, version, rootURI }, reason)`:

| Function | Called |
| --- | --- |
| `install` | once, after the extension is installed or updated |
| `startup` | when it starts: at launch, after installing, after being enabled |
| `shutdown` | when it stops: at quit, before updating, when disabled or removed |
| `uninstall` | once, before it is removed or replaced by an update |
| `onMainWindowLoad` / `onMainWindowUnload` | with `{ window }`, as main windows open and close |

`reason` is one of `APP_STARTUP`, `APP_SHUTDOWN`, `ADDON_ENABLE`,
`ADDON_DISABLE`, `ADDON_INSTALL`, `ADDON_UNINSTALL`, `ADDON_UPGRADE` and
`ADDON_DOWNGRADE`, all defined in the sandbox. Undo in `shutdown` whatever
`startup` did; an extension can be stopped and started again without a
restart.

The sandbox has `Zotero` (the whole app), `Services`, `ChromeUtils`, `IOUtils`,
`PathUtils`, `fetch`, `crypto`, `URL`, timers, and the rest of a privileged
Gecko scope. `rootURI` points into the `.xpi`, for icons and other files.
Default prefs go in a `prefs.js` at the root, and Fluent strings in
`locale/<language>/<name>.ftl`.

An extension runs with all of Paperly's access. Declare what you use in your
listing ([POLICY.md](../POLICY.md#4-what-you-must-declare)); the marketplace's
checks compare your code with it.

## Paperly's API, version 1

`Zotero.PaperlyExtensions` is Paperly's own. Check for it, so the extension
still loads in plain Zotero:

```js
if (Zotero.PaperlyExtensions?.apiVersion >= 1) {
  // ...
}
```

### `registerView(view)` → `remove()`

Gives the extension a view of its own in Paperly's Extensions window
(**Tools → Extensions…**), with a button in the window's left-hand bar. This is
the place for an extension's interface: Paperly's own windows stay as they
are, and the user opens the view when they want it.

| Field | |
| --- | --- |
| `pluginID` | Your extension's id, the `id` passed to `startup` |
| `id` | Unique within your extension |
| `label` | The view's title, and the button's tooltip |
| `icon` | Optional. An image URL, such as `rootURI + "icon-96.png"` |
| `onRender({ body, window })` | Draws the view into `body`, an empty HTML element. Called once in each Extensions window, the first time the view is shown there; may return a promise |
| `onDestroy({ body, window })` | Optional. Called when that window closes or the view goes |

The view stays drawn while the window is open, so it keeps its state as the
user switches between views. It goes away when your extension stops, however
that happens; calling `remove()` takes it away sooner. Registering the same
`pluginID` and `id` again replaces it.

Build the view with `body.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", ...)`.
The window follows Paperly's light and dark themes; its CSS variables, such as
`--fill-primary`, `--fill-secondary`, `--material-background` and
`--accent-blue`, make a view follow them too.

### `openWindow({ view, extensionID })`

Opens the Extensions window, or brings it forward. `view` (`"<pluginID>:<id>"`)
shows that view; `extensionID` shows an extension's details instead.

### `getContext()`

What the user is working on in the main window, for a view to act on:

```js
{
  items: [/* Zotero.Item */],      // selected in the library, or the open reader's item
  reader: null | {
    attachment,                    // the Zotero.Item of the PDF or EPUB being read
    selectedText,                  // the text last selected in it, or ""
    pageLabel,                     // that selection's page label, or null
  },
}
```

```js
const { items, reader } = Zotero.PaperlyExtensions.getContext();
if (reader?.selectedText) {
  // Work on what the user highlighted, then show the result in your view
}
```

### Stability

Everything in this section keeps working for the life of an API version.
`apiVersion` goes up only for a change that could break an extension written
against the version before, and the change is described here.

## Zotero's APIs

Through `Zotero`, an extension can use everything Zotero's own plugins can:
the library (`Zotero.Items`, `Zotero.Collections`, `Zotero.Search`,
`Zotero.Notifier`), and Zotero's plugin APIs for the item pane, the item list's
columns and the reader. Those follow Zotero, and can change when Paperly moves
to a new Zotero version; set `strict_max_version` to the Paperly versions you
have tested, so that an incompatible version is never installed.

Prefer a view for anything new you show. Add to Paperly's own windows only
where your extension cannot work otherwise, and leave them as you found them
in `shutdown`.

## Types

[`template/types/paperly.d.ts`](../template/types/paperly.d.ts) declares this
API for TypeScript and for editors' completion.

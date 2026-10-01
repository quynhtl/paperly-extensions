# Hello Paperly

A starting point for a Paperly extension: a view in Paperly's Extensions
window that shows what is selected in the main window and lists what was added
to the library last. Copy this folder into a repository of your own and make it
yours.

```
src/manifest.json   who the extension is
src/bootstrap.js    what it does
src/icon-*.png      how it looks in the marketplace (PNG or JPEG)
scripts/build.mjs   makes dist/<id>-<version>.xpi
types/paperly.d.ts  Paperly's API, for TypeScript and editors
```

1. **Choose an id** to replace the placeholder `hello-paperly@example.invalid`
   in `src/manifest.json`, such as `my-extension@<your-login>.github.io` with
   your GitHub login. It can never change once the extension is listed. Set
   `update_url` to match; `npm run build` tells you the exact value if it is
   wrong, and refuses the placeholder.
2. **Write the extension** in `src/bootstrap.js`. The
   [API guide](https://github.com/quynhtl/paperly-extensions/blob/main/docs/api.md) lists what Paperly gives an extension.
3. **Build** with `npm run build` (Node 20 or later, nothing to install).
4. **Try it** in Paperly: Tools → Plugins, then the gear menu → Install Plugin
   From File…, and pick the `.xpi`. Its view appears in Tools → Extensions….
   To try it from a local test marketplace instead, build with
   `PAPERLY_MARKETPLACE=http://127.0.0.1:8765/ npm run build` (which may keep
   the placeholder id, since that build is only for trying), and follow
   [the marketplace's README](https://github.com/quynhtl/paperly-extensions#what-gets-published).
5. **Publish** it: see [Getting started](https://github.com/quynhtl/paperly-extensions/blob/main/docs/getting-started.md).

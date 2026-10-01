# Hello Paperly

A starting point for a Paperly extension: a view in Paperly's Extensions
window that shows what is selected in the main window and lists what was added
to the library last. Copy this folder into a repository of your own and make it
yours.

```
src/manifest.json   who the extension is
src/bootstrap.js    what it does
src/icon.svg        how it looks in the marketplace
scripts/build.mjs   makes dist/<id>-<version>.xpi
types/paperly.d.ts  Paperly's API, for TypeScript and editors
```

1. **Choose an id** in `src/manifest.json`, such as `my-extension@your-domain`.
   It can never change once the extension is listed. Set `update_url` to match;
   `npm run build` tells you the exact value if it is wrong.
2. **Write the extension** in `src/bootstrap.js`. The
   [API guide](../docs/api.md) lists what Paperly gives an extension.
3. **Build** with `npm run build` (Node 18 or later, nothing to install).
4. **Try it** in Paperly: Tools → Plugins, then the gear menu → Install Plugin
   From File…, and pick the `.xpi`. Its view appears in Tools → Extensions….
5. **Publish** it: see [Getting started](../docs/getting-started.md).

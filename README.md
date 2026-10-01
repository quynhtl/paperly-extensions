# Paperly Extensions

The marketplace behind Paperly's **Extensions** window: which extensions are
listed, what every version of them was checked for, and the signed index the
app reads.

Listing is open to everyone. There is no review queue: a version that passes
the automated checks is published, a version that fails is not, and what the
checks found is shown to people before they install. The rules are in
[POLICY.md](POLICY.md).

## How it fits together

```
your repo                  this repo                         Paperly
---------                  ---------                         -------
GitHub release  ──────▶   checks every .xpi  ──▶  index.json  ──▶  Extensions window
(with an .xpi)             keeps a copy of it      (signed)        installs the copy,
                           updates/<id>.json  ───────────────▶     the add-on manager
                                                                    takes updates from it
```

People only ever install the copy the marketplace keeps, and the app checks
its hash, so what they get is exactly what was checked.

## List your extension

1. **Build it as a Paperly plugin**: an `.xpi` with a `manifest.json` and a
   `bootstrap.js`, the same format as a Zotero 7+ plugin. Its
   `applications.zotero` block needs an `id`, a `strict_min_version` and a
   `strict_max_version`.
2. **Point its updates at the marketplace.** Set
   `applications.zotero.update_url` to

   ```
   https://quynhtl.github.io/paperly-extensions/updates/<id>.json
   ```

   where `<id>` is your extension's id, with any character other than
   letters, digits, `.`, `_`, `@` and `-` replaced by `_`.
3. **Publish a GitHub release** in a public repository, with the `.xpi`
   attached.
4. **Open a pull request** adding `extensions/<id>.json` (below). It must
   come from the owner of the repository named in it.

## The listing file

`extensions/<id>.json`, for example
[paperly-ai@paperly.org.json](extensions/paperly-ai@paperly.org.json):

| Field | | |
| --- | --- | --- |
| `id` | required | The id in your `manifest.json`. |
| `name` | required | Up to 50 characters. |
| `description` | required | Up to 250 characters. |
| `repo` | required | `owner/name` of the public GitHub repository with the releases. |
| `declares` | required | What the extension does, see [POLICY.md](POLICY.md#4-what-you-must-declare). `{}` if none of it. |
| `publisher` | optional | The name people see. Defaults to the repository owner. |
| `categories` | optional | Any of `ai`, `reading`, `writing`, `citations`, `notes`, `organization`, `import-export`, `appearance`, `integration`, `other`. |
| `homepage` | optional | An `https://` page about the extension. |
| `license` | optional | An SPDX id, such as `MIT` or `AGPL-3.0-or-later`. |
| `privacyPolicy` | optional | An `https://` page; expected when `declares.sendsContent` is true. |

## Updates

Publish a new GitHub release. The marketplace looks for new releases every few
hours, checks them, and offers the new version to everyone who has the
extension. Newest first, the last five passing versions are kept.

## Blocking

[`blocked.json`](blocked.json) is the kill switch. It uses the format of
Zotero's own list of blocked plugins:

```json
{
  "example@example.com": {
    "versionRanges": [{ "maxVersion": "1.2.3" }],
    "reason": "Versions before 1.2.4 send the library to an undisclosed server."
  }
}
```

A version range is `"*"`, one exact version, or an object with `minVersion`
and/or `maxVersion`. Paperly switches blocked versions off on every computer
the next time it reads the index, and shows the reason. Only maintainers
change this file.

## This repository

| Path | |
| --- | --- |
| `extensions/` | One listing per extension. |
| `blocked.json` | The kill switch. |
| `registry.json` | Where the marketplace is published, and which Paperly version the checks assume. |
| `POLICY.md` | The rules. |

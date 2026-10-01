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

New to Paperly extensions? Start from [`template/`](template), a working
extension that already passes the checks, and follow
[docs/getting-started.md](docs/getting-started.md).

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
4. **Check it** the way the marketplace will (Node 20 or later, nothing to
   install):

   ```sh
   node scripts/check.mjs extensions/<id>.json --xpi path/to/your.xpi
   ```

5. **Open a pull request** adding `extensions/<id>.json` (below). It must
   come from the owner of the repository named in it.

## The listing file

`extensions/<id>.json`, named with the same character rule as the update URL,
for example
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
| `publisherDomain` | optional | A domain you control, to be shown as a verified publisher (below). |

## What is checked

Every version, before it is published
([scripts/lib/inspect.mjs](scripts/lib/inspect.mjs)):

| Kept out of the marketplace | Shown as a warning | Shown in the details |
| --- | --- | --- |
| not a readable `.xpi`, or over 20 MB | code that reads cookies, passwords or keys, starts programs, uses the clipboard or writes files without the listing declaring it | web addresses in the code that the listing doesn't declare |
| `manifest.json` missing, invalid, or not `manifest_version` 2 | a version that doesn't run in the current Paperly | code built from text while running (`eval`, `new Function`) |
| an id other than the listing's | `sendsContent` without a `privacyPolicy` | |
| an `update_url` other than the marketplace's | | |
| no `strict_min_version`/`strict_max_version`, or no `bootstrap.js` | | |
| code loaded from the internet, or obfuscated code | | |

The checks read the code; they cannot prove an extension is safe. They are
there so that what an extension does is visible before someone installs it.

## Verified publishers

Paperly marks a publisher as verified when they prove they control a domain.
Set `publisherDomain` in your listing and serve, from that domain,

```
https://<publisherDomain>/.well-known/paperly-extensions.json
```

```json
{ "repos": ["your-name/your-extension"] }
```

listing the repository named in your listing (any others too). The file is
fetched again on every publish, without following redirects; taking it down
takes the badge away. Extensions published from the marketplace's own GitHub
account are marked official.

Verified says who publishes an extension. It doesn't say the extension is safe.

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

## What gets published

`node scripts/build.mjs --out dist` turns the listings into the site Paperly
reads (see [scripts/lib/build.mjs](scripts/lib/build.mjs)):

| Path | |
| --- | --- |
| `index.json` | Every listed extension, its versions, what each was found to use, and the blocks. |
| `index.json.sig` | ECDSA P-256 signature of `index.json`. Paperly refuses an index it cannot verify. |
| `files/<id>/<id>-<version>.xpi` | The checked copy of each version, which is what people install. |
| `updates/<id>.json` | The update manifest each extension's `update_url` points at. |
| `icons/<id>.png` | Taken from the newest version's `manifest.json` icons. |
| `report.json` | What was accepted and rejected, and why. |

To try an extension in a local marketplace before releasing it:

```sh
node scripts/keygen.mjs                      # once; keep the private key in a file
node scripts/build.mjs --out dist --base-url http://127.0.0.1:8765/ \
  --key-file dev.key --local <id>=path/to/your.xpi
python3 -m http.server 8765 -d dist
```

then point a test profile of Paperly at it: set
`extensions.zotero.paperlyExtensions.registryURL` to the base URL and
`extensions.zotero.paperlyExtensions.publicKey` to the public key. The `.xpi`'s
`update_url` must use the local base URL too, and because that is plain HTTP,
the test profile also needs `extensions.checkUpdateSecurity` set to `false`;
otherwise the add-on manager installs the extension but keeps it disabled.

## What runs on GitHub

| Workflow | When | What |
| --- | --- | --- |
| [listing.yml](.github/workflows/listing.yml) | A pull request touches `extensions/` | Checks the listings and the newest release of each, comments with the result, and merges when everything passes and the author owns every repository involved ([scripts/lib/review.mjs](scripts/lib/review.mjs)). Anything else waits for a maintainer. |
| [publish.yml](.github/workflows/publish.yml) | Push to `main`, every three hours, or by hand | Builds, signs and deploys the site to GitHub Pages. |
| [test.yml](.github/workflows/test.yml) | Every pull request and push | `npm test` and every listing. |

`listing.yml` holds a token that can write to this repository, so it runs only
the base branch's scripts and reads the pull request's listings as data. It
checks the one commit the pull request's event named, and merges only that
commit: if anything is pushed while the check runs, nothing is merged.

## Setting up the marketplace

Once, by a maintainer:

1. `node scripts/keygen.mjs`. Put the private key in the repository's
   **REGISTRY_SIGNING_KEY** Actions secret, and the public key in
   paperly-client's `defaults/preferences/zotero.js`
   (`extensions.zotero.paperlyExtensions.publicKey`). Keep the private key
   only in that secret, and delete every other copy once it is saved there:
   whoever has it can tell every copy of Paperly what to install.
2. Turn on GitHub Pages with **GitHub Actions** as the source.
3. Protect `main` (Settings, Branches, or Rules): no force-pushes, and no
   deletion. Everything published is built from `main`, so its history must
   only ever move forward.
4. If the site is not `https://quynhtl.github.io/paperly-extensions/`, change
   `baseURL` in `registry.json` and `extensions.zotero.paperlyExtensions.registryURL`
   in paperly-client to match.

## This repository

| Path | |
| --- | --- |
| `extensions/` | One listing per extension. |
| `blocked.json` | The kill switch. |
| `registry.json` | Where the marketplace is published, and which Paperly version the checks assume. |
| `POLICY.md` | The rules. |
| `template/` | A starting point for a new extension, with its own build script. |
| `docs/` | [Getting started](docs/getting-started.md), and [the API](docs/api.md) an extension can use. |
| `scripts/check.mjs` | Checks listings, and a built `.xpi` against its listing. |
| `scripts/build.mjs` | Builds and signs the published site. |
| `scripts/keygen.mjs` | Makes the signing key pair. |
| `scripts/review-pr.mjs` | Reviews a pull request in GitHub Actions. |
| `scripts/lib/verify.mjs` | Checks a publisher's domain. |
| `scripts/lib/` | The checks themselves, and a ZIP reader that never unpacks to disk. |
| `test/` | `npm test`. |

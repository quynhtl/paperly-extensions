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
   `strict_max_version`. Choose an id under a name that is yours, such as
   `my-extension@<your-login>.github.io` (below).
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

5. **Open a pull request** adding `extensions/<id>.json` (below), from the
   GitHub account that owns the repository named in it. A repository owned by
   an organisation is listed by a maintainer: its pull request stays open
   until one has looked at it.

## The listing file

`extensions/<id>.json`, named with the same character rule as the update URL,
for example
[paperly-ai@paperly.org.json](extensions/paperly-ai@paperly.org.json):

| Field | | |
| --- | --- | --- |
| `id` | required | The id in your `manifest.json`. A new listing is merged automatically only when its id ends in `@<your-login>.github.io`, or in `@` your `publisherDomain` or a subdomain of it, verified (below). Any other id waits for a maintainer, who checks that it is yours to list. |
| `name` | required | Up to 50 characters. |
| `description` | required | Up to 250 characters. |
| `repo` | required | `owner/name` of the public GitHub repository with the releases. |
| `repoId` | required | That repository's numeric id. It stays with the repository when it or its owner is renamed, so the listing can never point at someone else who takes the old name. `node scripts/check.mjs --repo-id owner/name` prints it, and so does `https://api.github.com/repos/owner/name` (its `"id"`). |
| `declares` | required | What the extension does, see [POLICY.md](POLICY.md#4-what-you-must-declare). `{}` if none of it. |
| `publisher` | optional | The name people see. Defaults to the repository owner. |
| `categories` | optional | Up to three of `ai`, `reading`, `writing`, `citations`, `notes`, `organization`, `import-export`, `appearance`, `integration`, `other`. |
| `homepage` | optional | An `https://` page about the extension. |
| `license` | optional | An SPDX id, such as `MIT` or `AGPL-3.0-or-later`. |
| `privacyPolicy` | optional | An `https://` page; expected when `declares.sendsContent` is true. |
| `publisherDomain` | optional | A domain you control, to be shown as a verified publisher (below). |
| `delisted` | optional | `true` to stop publishing the extension (below). |

## What is checked

Every version, before it is published
([scripts/lib/inspect.mjs](scripts/lib/inspect.mjs)):

| Kept out of the marketplace | Shown as a warning | Shown in the details |
| --- | --- | --- |
| not a readable `.xpi`, or over 20 MB | code that reads cookies, passwords or keys, starts programs, uses the clipboard or writes files without the listing declaring it | web addresses in the code that the listing doesn't declare |
| `manifest.json` missing, invalid, or not `manifest_version` 2 | a version that doesn't run in the current Paperly | code built from text while running (`eval`, `new Function`) |
| a file of code over 8 MB, too large to check | | an SVG icon that is more than a drawing (scripts, event handlers, HTML, links, a DOCTYPE or entities), which is then not shown |
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

A verified domain also lets a new listing whose id is under it, such as
`my-extension@example.org` or `my-extension@tools.example.org` for
`example.org`, be merged automatically.

Verified says who publishes an extension. It doesn't say the extension is safe.

## Updates

Publish a new GitHub release. The marketplace looks for new releases every few
hours, checks them, and offers the new version to everyone who has the
extension. Newest first, the last five passing versions are kept; releases
marked as pre-releases, and drafts, are skipped.

## Delisting

To take your extension out of the marketplace, set `"delisted": true` in its
listing; a pull request that does only that, from the repository's owner, is
merged automatically. Listings are never deleted: copies already installed go
on asking the marketplace for updates under the extension's id, so an id
once listed is never given to anyone else. A pull request that deletes or
renames a listing waits for a maintainer.

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

A block applies to the copies installed from the marketplace, whose
`update_url` is the marketplace's. A plugin with the same id installed some
other way is left alone, so that a block aimed at a listing never switches
off a different plugin that happens to share its id. For an id known to be
malicious wherever it comes from, add `"global": true` to its entry, and the
block applies to every copy.

## What gets published

`node scripts/build.mjs --out dist` turns the listings into the site Paperly
reads (see [scripts/lib/build.mjs](scripts/lib/build.mjs)):

| Path | |
| --- | --- |
| `index.json` | Every listed extension, its versions, what each was found to use, and the blocks. |
| `index.json.sig` | ECDSA P-256 signature of `index.json`. Paperly refuses an index it cannot verify. |
| `files/<id>/<id>-<version>.xpi` | The checked copy of each version, which is what people install. |
| `updates/<id>.json` | The update manifest each extension's `update_url` points at. |
| `icons/<id>.png`, `.svg` or `.jpg` | The newest version's icon from its `manifest.json` (the smallest of 64px or more, else the largest), in its own format. |
| `report.json` | What was accepted and rejected, and why. |

To try an extension in a local marketplace before releasing it, first write
its listing, `extensions/<id>.json`: only listed extensions are built. (For a
local build `repoId` is not looked up, so any number does until the
repository exists.) Then build the `.xpi` for the local marketplace, and the
marketplace around it:

```sh
# in your extension's folder (made from template/); src/ stays as it is,
# and the .xpi's update_url points at the local marketplace
PAPERLY_MARKETPLACE=http://127.0.0.1:8765/ npm run build

# here
node scripts/keygen.mjs                      # once; keep the private key in a file
node scripts/build.mjs --out dist --base-url http://127.0.0.1:8765/ \
  --key-file dev.key --local <id>=path/to/your.xpi
python3 -m http.server 8765 -d dist
```

then point a test profile of Paperly at it: set
`extensions.zotero.paperlyExtensions.registryURL` to the base URL and
`extensions.zotero.paperlyExtensions.publicKey` to the public key. Because the
local marketplace is plain HTTP, the test profile also needs
`extensions.checkUpdateSecurity` set to `false`; otherwise the add-on manager
installs the extension but keeps it disabled. An `.xpi` built for a local
marketplace is refused by the real one, so release one built without
`PAPERLY_MARKETPLACE`.

## What runs on GitHub

| Workflow | When | What |
| --- | --- | --- |
| [listing.yml](.github/workflows/listing.yml) | A pull request touches `extensions/` | Checks the listings and the newest release of each, comments with the result, and merges when everything passes and the author owns every repository involved, going by GitHub's numeric ids rather than names ([scripts/lib/review.mjs](scripts/lib/review.mjs)). Anything else waits for a maintainer, including a repository owned by an organisation, and a listing moved to another repository. |
| [publish.yml](.github/workflows/publish.yml) | Push to `main`, every three hours, or by hand | Builds, signs and deploys the site to GitHub Pages. If GitHub cannot be asked about every listing, or a release cannot be downloaded from it, nothing is deployed and the site already up stays up. |
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
2. Give publishing a GitHub token of its own: a fine-grained personal access
   token with **Public repositories (read-only)** access and no permissions,
   in the **PUBLISH_GITHUB_TOKEN** Actions secret. Without it, the build uses
   the workflow's `GITHUB_TOKEN`, whose budget of 1,000 requests an hour is
   shared with the checks of pull requests; anyone opening enough of them
   could spend it, and a build GitHub stops answering deploys nothing, new
   blocks included. Renew the token before it expires: publishing stops when
   it does.
3. Turn on GitHub Pages with **GitHub Actions** as the source.
4. Protect `main` (Settings, Branches, or Rules): no force-pushes, and no
   deletion. Everything published is built from `main`, so its history must
   only ever move forward.
5. If the site is not `https://quynhtl.github.io/paperly-extensions/`, change
   its address everywhere it is written, all together (`npm test` checks the
   ones in this repository against `registry.json`):
   - `baseURL` in `registry.json`;
   - `MARKETPLACE` in `template/scripts/build.mjs`, and `update_url` in
     `template/src/manifest.json`;
   - the update URL in this README (step 2 of "List your extension") and in
     `docs/getting-started.md`;
   - in paperly-client's `defaults/preferences/zotero.js`,
     `extensions.zotero.paperlyExtensions.registryURL`, and
     `extensions.zotero.paperlyExtensions.publicKey` if the key changes too;
   - `updateURL` in paperly-plugin's `zotero-plugin.config.ts`. Then rebuild
     Paperly AI, publish the build as a new release, and bundle it into
     paperly-client again: every copy asks for updates at the address it was
     built with, the one installed with Paperly included.
   - if this repository itself is renamed or moved, the links to it in
     `template/README.md`, which is copied out of this repository and so
     links here in full.

   Settle the address before anything built with it ships. A copy already
   installed goes on asking the old address for updates, and GitHub Pages
   does not redirect it.

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

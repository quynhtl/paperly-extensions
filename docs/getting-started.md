# Getting started

From an empty folder to an extension people can install from Paperly's
Extensions window. You need Node 20 or later, Paperly, and a GitHub account.

## 1. Start from the template

Copy [`template/`](../template) into a new repository. It is a complete
extension that adds a view to the Extensions window, and it already passes the
marketplace's checks.

In `src/manifest.json`, set:

- `applications.zotero.id`: your extension's permanent id, in place of the
  template's placeholder `hello-paperly@example.invalid`, which the build
  refuses. Choose one such as `citation-check@<your-login>.github.io`, with
  your GitHub login. It can never change once the extension is listed. A new
  listing is merged automatically only when its id ends in
  `@<your-login>.github.io`, or in `@` a domain you have verified as your
  `publisherDomain` by serving a file there that lists your repository's
  numeric id (see the [README](../README.md#verified-publishers)); any other
  id waits for a maintainer.
- `applications.zotero.update_url`:
  `https://quynhtl.github.io/paperly-extensions/updates/<id>.json`. The build
  prints the exact value if yours is wrong.
- `name`, `description`, `author`, `homepage_url`, and `version`.
- `strict_min_version` and `strict_max_version`: the Paperly versions you have
  tested. `10.999` to `11.*` means every Paperly 11, development builds
  included.

## 2. Write it

`src/bootstrap.js` is the extension. Paperly calls its `startup` when the
extension starts (at launch, after installing, after enabling) and `shutdown`
when it stops. Undo in `shutdown` whatever `startup` did.

[The API guide](api.md) lists what you can use: your own view in the
Extensions window, and the rest of Paperly through the `Zotero` object.

## 3. Build and try it

```sh
npm run build              # dist/<id>-<version>.xpi
```

In Paperly: **Tools → Plugins**, the gear menu, **Install Plugin From File…**,
and pick the `.xpi`. Open **Tools → Extensions…**: your extension is under
Installed (marked as not from the marketplace, since you installed it by
hand), and its view has a button in the bar on the left.

While working, **Help → Debug Output Logging** shows what `Zotero.debug()`
writes, and **Tools → Developer → Run JavaScript** lets you try code against
the running app.

## 4. Check it as the marketplace will

Clone this repository and write your listing, `extensions/<id>.json` (see
the [README](../README.md#the-listing-file)). Its `repoId` is your GitHub
repository's numeric id, which you look up in step 5, once the repository is
on GitHub; until then any positive number, such as `1`, does for this check.
Then:

```sh
node scripts/check.mjs extensions/<id>.json --xpi path/to/your.xpi
```

Fix anything it marks `error`. Declare in the listing whatever it marks as a
`warning` about something undeclared, or remove that code.

## 5. Publish

1. Push your repository to GitHub, public.
2. Create a release whose tag is the version (`v1.0.0`), with the `.xpi`
   attached.
3. Replace the listing's placeholder `repoId` with your repository's numeric
   id, which `node scripts/check.mjs --repo-id your-name/your-repo` prints.
4. Open a pull request here adding `extensions/<id>.json`, from the GitHub
   account that owns your repository. (A repository owned by an organisation
   is listed by a maintainer, so that pull request waits for one.)

The pull request is checked automatically and merged when everything passes;
your extension appears in Paperly within a few hours. A draft pull request is
checked too, but merged only once you mark it ready for review. Later versions need no
pull request: publish a new release and the marketplace picks it up.

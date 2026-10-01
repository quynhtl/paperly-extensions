# Developer policy

Every extension listed in the Paperly marketplace follows these rules. They
exist because a Paperly extension runs with the same access as Paperly itself:
it can read the whole library, the files on the computer and the sign-ins kept
in the app. Nothing in the app can stop an extension that wants to misuse that,
so the marketplace relies on three things instead: honest declarations, an
automated check of every version, and the power to switch an extension off on
every computer at once.

Listing is open. There is no manual review queue: a version that passes the
automated checks is published, and what the checks found is shown to people
before they install it.

## 1. Who can list

- Anyone with a public GitHub repository that holds the extension's source.
- The listing must be submitted by the owner of that repository. A listing for
  a repository a user owns is merged as soon as it passes the checks; one for
  a repository an organisation owns is merged by a maintainer, once they know
  the person asking speaks for the organisation.
- One listing per extension id. The id is the one in your `manifest.json`
  (`applications.zotero.id`) and cannot be changed later, and neither can the
  repository without a maintainer's agreement.

## 2. What you agree to

- Keep the extension working, or ask for it to be delisted.
- Answer security reports. An extension with a known, unanswered security
  problem is blocked.
- Describe the extension accurately, and keep `declares` in your listing true
  for every version you release.
- Follow the terms of any service your extension uses. You, not Paperly, are
  responsible for how your extension uses other people's services.

## 3. Not allowed

A version that does any of these is rejected by the checks, or blocked when it
is found later:

- **Obfuscated code.** Minified or bundled code is fine; code made deliberately
  unreadable is not.
- **Code loaded from the internet.** Everything that runs must be inside the
  `.xpi` that was checked. No remote scripts, no `eval` of downloaded text.
- **Updating outside the marketplace.** `applications.zotero.update_url` must
  point at the marketplace (see the README), so that every version people get
  is a version that was checked.
- **Tracking people without asking.** No analytics or telemetry unless the user
  turned it on.
- **Ads inside Paperly's own interface.**
- **Malware**, or anything that hides what it does.
- **Pretending to be someone else.** Do not use another company's or product's
  name or logo in a way that suggests they made or endorse your extension
  (for example naming an extension "Claude" or "QuillBot" when you are not
  Anthropic or QuillBot). Saying truthfully what your extension works with is
  fine.

## 4. What you must declare

The `declares` object in your listing tells people what the extension does
before they install it. Declare it if any version does it:

| Key | Declare when the extension... |
| --- | --- |
| `network` | contacts or embeds a web service: list every host name |
| `sendsContent` | sends the text of papers, notes, annotations or item data to a web service |
| `clipboard` | reads or writes the clipboard |
| `files` | reads or writes files outside its own data, or asks the user for files |
| `cookies` | reads cookies or sign-ins kept by Paperly |
| `passwords` | reads saved passwords or API keys kept by Paperly |
| `programs` | starts other programs on the computer |

The checks look for these in the code as well. Something found but not declared
is shown to people as a warning next to the install button.

If `sendsContent` is true, give a privacy policy (`privacyPolicy` in the
listing) saying what is sent, where, and how long it is kept. Without one the
listing shows a warning.

## 5. Personal data

People's libraries hold their own writing and other people's personal data.
If your extension sends any of it anywhere, ask the user first, say where it
goes, and follow the data protection laws that apply to you and to your users
(for example the GDPR in the EU, or Vietnam's Law on Personal Data Protection,
No. 91/2025/QH15).

## 6. Licences

State a licence in your repository. Paperly is free software under the
GNU AGPL v3, and an extension runs inside it. Whether your extension must be
under an AGPL-compatible licence depends on how it is built and distributed;
if you plan a closed-source extension, get legal advice first. Extensions that
only talk to Paperly over a network API (for example through the local API)
are not affected.

## 7. Verified publishers

A publisher who proves control of a domain is shown as verified (see the
README). The badge says who publishes the extension; the rules above apply to
every extension alike, verified or not. Claiming a domain you don't control is
impersonation, and gets every listing of yours blocked.

## 8. Blocking and removal

The maintainers can block any extension, or any range of its versions, at any
time: for malware, for a broken security promise, for breaking these rules, or
because the law requires it. A block switches the extension off on every
computer the next time Paperly checks the marketplace, and the reason is shown
to the user.

If you think a block is wrong, open an issue in this repository. If the problem
is fixed in a new version, the block can be narrowed to the old ones.

To delist your own extension, open a pull request removing its listing. People
who have it keep it, but it stops getting updates.

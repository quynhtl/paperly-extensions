/* global Zotero */
// Hello Paperly: the smallest useful Paperly extension.
//
// Paperly runs this file in a sandbox of its own, with `Zotero` (the whole app,
// library included) in scope, and calls the functions below as the extension
// is installed, started, stopped and removed. See docs/api.md in the
// paperly-extensions repository for the rest of what an extension can use.

var removeView = null;

function install() {}

function uninstall() {}

function startup({ id, rootURI }) {
  // The Extensions window and its views are Paperly's. In plain Zotero there is
  // no such window, so the extension simply has nothing to show.
  if (!Zotero.PaperlyExtensions) {
    return;
  }
  removeView = Zotero.PaperlyExtensions.registerView({
    pluginID: id,
    id: "recent",
    label: "Hello Paperly",
    icon: rootURI + "icon.svg",
    onRender({ body }) {
      return render(body);
    },
  });
}

function shutdown() {
  // Paperly removes an extension's views when it stops anyway; this keeps the
  // extension tidy if it ever stops its view earlier itself.
  if (removeView) {
    removeView();
    removeView = null;
  }
}

/** Draws the view: the five items most recently added to My Library. */
async function render(body) {
  const doc = body.ownerDocument;
  const html = (tag, text) => {
    const element = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };

  const list = html("ol");
  const refresh = html("button", "Refresh");
  body.append(html("p", "Added to My Library most recently:"), list, refresh);

  async function fill() {
    const items = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true))
      .filter((item) => item.isRegularItem())
      .sort((a, b) => b.dateAdded.localeCompare(a.dateAdded))
      .slice(0, 5);
    list.replaceChildren(
      ...(items.length ? items.map((item) => html("li", item.getDisplayTitle())) : [html("li", "Nothing yet.")]),
    );
  }
  refresh.addEventListener("click", fill);
  await fill();
}

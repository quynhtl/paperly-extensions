// Paperly's extension API, version 1: Zotero.PaperlyExtensions.
// See docs/api.md in the paperly-extensions repository.
//
// Zotero's own types come from the zotero-types package; without it, the
// items here are typed loosely.

declare namespace PaperlyExtensions {
  /** A Zotero.Item, loosely: install zotero-types for the full type. */
  interface Item {
    id: number;
    key: string;
    getDisplayTitle(): string;
    [property: string]: unknown;
  }

  interface ViewArguments {
    /** An empty HTML element to draw the view into. */
    body: HTMLElement;
    /** The Extensions window the view is in. */
    window: Window;
  }

  interface View {
    /** The extension's id, as passed to startup. */
    pluginID: string;
    /** Unique within the extension. */
    id: string;
    /** The view's title, and its button's tooltip. */
    label: string;
    /** An image URL for the button, such as rootURI + "icon.svg". */
    icon?: string;
    /** Called once in each Extensions window, the first time the view is shown there. */
    onRender(args: ViewArguments): void | Promise<void>;
    /** Called when that window closes, or the view goes. */
    onDestroy?(args: ViewArguments): void;
  }

  interface Context {
    /** Selected in the library, or the open reader's item. */
    items: Item[];
    reader: null | {
      /** The PDF or EPUB being read. */
      attachment: Item;
      /** The text last selected in it, or "". */
      selectedText: string;
      /** That selection's page label, or null. */
      pageLabel: string | null;
    };
  }

  interface API {
    readonly apiVersion: number;
    /** Adds a view to the Extensions window; returns a function that removes it. */
    registerView(view: View): () => void;
    /** Opens the Extensions window, showing a view ("<pluginID>:<id>") or an extension's details. */
    openWindow(options?: { view?: string; extensionID?: string }): Window;
    /** What the user is working on in the main window. */
    getContext(): Context;
  }
}

declare namespace Zotero {
  /** Undefined outside Paperly, such as in plain Zotero. */
  const PaperlyExtensions: PaperlyExtensions.API | undefined;
}

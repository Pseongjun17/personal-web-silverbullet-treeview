/**
 * @typedef {import("../api.ts").TreeNode} TreeNode
 */

/**
 * @typedef SortableTreeNode
 * @type {Object}
 * @property {TreeNode["data"]} data
 */

/**
 *
 * @typedef TreeViewConfig
 * @type {Object}
 * @property {string} currentPage - the current page shown in SilverBullet.
 * @property {TreeNode[]} nodes - a tree of all pages in the current space.
 * @property {Object} dragAndDrop - drag and drop related config
 * @property {boolean} dragAndDrop.enabled - true if drag and drop is enabled
 * @property {boolean} dragAndDrop.confirmOnRename - true if a confirmation should be shown
 *  when a node is dragged and dropped.
 * @property {Object} nodeActions - config for the file/folder management actions
 * @property {Object} nodeActions.icons - icon markup used for the action buttons/menu
*/


const TREE_STATE_ID = "treeview";

/**
 * Escapes a string for safe use inside an HTML attribute.
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Strips leading/trailing slashes and whitespace from user-provided page/folder names.
 * @param {string} raw
 * @returns {string | undefined}
 */
function normalizeEntryName(raw) {
  const trimmed = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  return trimmed || undefined;
}

/**
 * Prompts for a new page or folder name and creates it as an (empty) page.
 * A "folder" is nothing more than a page created at that path -- SilverBullet
 * has no concept of an empty folder, so creating a folder really just creates
 * a placeholder page that will be shown as a folder (note) once other pages
 * exist underneath it.
 * @param {string} parentName - the folder/page path to create the new entry under, or "" for the root.
 * @param {boolean} isFolder
 */
async function createEntry(parentName, isFolder) {
  const defaultValue = parentName ? `${parentName}/` : "";
  const input = await syscall(
    "editor.prompt",
    isFolder ? "New folder name:" : "New page name:",
    defaultValue,
  );
  if (input === undefined || input === defaultValue) {
    // Cancelled, or submitted unchanged (nothing was actually typed).
    return;
  }
  const name = normalizeEntryName(input);
  if (!name) {
    return;
  }

  try {
    await syscall("space.getPageMeta", name);
    await syscall(
      "editor.flashNotification",
      `"${name}" already exists.`,
      "error",
    );
    return;
  } catch (err) {
    if (!String(err?.message ?? err).includes("Not found")) {
      await syscall(
        "editor.flashNotification",
        `Failed to create "${name}": ${err?.message ?? err}`,
        "error",
      );
      return;
    }
  }

  try {
    await syscall("space.writePage", name, "");
    await syscall("system.invokeFunction", "treeview.show");
    await syscall("editor.navigate", name, false, false);
  } catch (err) {
    await syscall(
      "editor.flashNotification",
      `Failed to create "${name}": ${err?.message ?? err}`,
      "error",
    );
  }
}

/**
 * Prompts for a new name and renames a page/folder/attachment by delegating
 * to the same `index.renamePrefixCommand` used for drag-and-drop moves. This
 * works for single pages and whole folders alike, since both are just prefixes.
 * @param {string} name
 */
async function renameEntry(name) {
  const input = await syscall("editor.prompt", `Rename "${name}" to:`, name);
  const newName = normalizeEntryName(input);
  if (!newName || newName === name) {
    return;
  }

  try {
    const success = await syscall(
      "system.invokeFunction",
      "index.renamePrefixCommand",
      {
        oldPrefix: name,
        newPrefix: newName,
        disableConfirmation: false,
      },
    );

    if (success) {
      await syscall("system.invokeFunction", "treeview.show");
    }
  } catch (err) {
    await syscall(
      "editor.flashNotification",
      `Failed to rename "${name}": ${err?.message ?? err}`,
      "error",
    );
  }
}

/**
 * Deletes a page, attachment, or folder (and everything nested inside it).
 * Folder deletion is derived purely from name prefixes -- any page or
 * attachment whose name equals `name` or starts with `name/` is considered
 * part of it, regardless of how it's currently classified in the tree
 * (plain folder vs. a "folder note" page that also has children).
 * @param {string} name
 * @param {string} nodeType
 */
async function deleteEntry(name, nodeType) {
  try {
    if (nodeType === "attachment") {
      if (
        !(await syscall(
          "editor.confirm",
          `Delete attachment "${name}"? This cannot be undone.`,
        ))
      ) {
        return;
      }
      await syscall("space.deleteAttachment", name);
      await syscall("system.invokeFunction", "treeview.show");
      return;
    }

    const [allPages, allAttachments] = await Promise.all([
      syscall("space.listPages"),
      syscall("space.listAttachments"),
    ]);
    const prefix = `${name}/`;
    const pagesToDelete = allPages.filter((p) =>
      p.name === name || p.name.startsWith(prefix)
    );
    const attachmentsToDelete = allAttachments.filter((a) =>
      a.name.startsWith(prefix)
    );

    if (pagesToDelete.length === 0) {
      await syscall(
        "editor.flashNotification",
        `"${name}" no longer exists.`,
        "error",
      );
      await syscall("system.invokeFunction", "treeview.show");
      return;
    }

    const totalCount = pagesToDelete.length + attachmentsToDelete.length;
    const message = totalCount === 1
      ? `Delete "${name}"? This cannot be undone.`
      : `Delete "${name}"? This will permanently delete ${pagesToDelete.length} page(s) and ${attachmentsToDelete.length} attachment(s). This cannot be undone.`;

    if (!(await syscall("editor.confirm", message))) {
      return;
    }

    const currentPage = await syscall("editor.getCurrentPage");
    if (pagesToDelete.some((p) => p.name === currentPage)) {
      await syscall("editor.navigate", "", false, false);
    }

    for (const page of pagesToDelete) {
      await syscall("space.deletePage", page.name);
    }
    for (const attachment of attachmentsToDelete) {
      await syscall("space.deleteAttachment", attachment.name);
    }

    await syscall("system.invokeFunction", "treeview.show");
  } catch (err) {
    await syscall(
      "editor.flashNotification",
      `Failed to delete "${name}": ${err?.message ?? err}`,
      "error",
    );
  }
}

/**
 * Dispatches a node action triggered from either the hover icons or the
 * right-click context menu.
 * @param {string} action
 * @param {string} name
 * @param {string} [nodeType]
 */
function performNodeAction(action, name, nodeType) {
  switch (action) {
    case "add-page":
      return createEntry(name, false);
    case "add-folder":
      return createEntry(name, true);
    case "rename":
      return renameEntry(name);
    case "delete":
      return deleteEntry(name, nodeType);
  }
}

/**
 * Builds the hover-revealed action icons markup for a single node label.
 * @param {SortableTreeNode["data"]} data
 * @param {Object} icons
 * @returns {string}
 */
function renderNodeActions(data, icons) {
  const canHaveChildren = data.nodeType !== "attachment";
  const name = escapeAttr(data.name);

  return `
    <span class="tv-node-actions">
      ${
    canHaveChildren
      ? `<button type="button" class="tv-node-action" data-tv-action="add-page" data-tv-name="${name}" data-tv-node-type="${data.nodeType}" title="Add page here">${
        icons.filePlus ?? "+"
      }</button>`
      : ""
  }
      <button type="button" class="tv-node-action" data-tv-action="rename" data-tv-name="${name}" data-tv-node-type="${data.nodeType}" title="Rename">${
    icons.edit ?? "&#9998;"
  }</button>
      <button type="button" class="tv-node-action" data-tv-action="delete" data-tv-name="${name}" data-tv-node-type="${data.nodeType}" title="Delete">${
    icons.trash ?? "&#128465;"
  }</button>
    </span>`;
}

let openContextMenu;
let contextMenuKeyHandler;

/**
 * Closes the currently open context menu, if any, and cleans up its
 * associated listeners.
 */
function closeContextMenu() {
  if (openContextMenu) {
    openContextMenu.remove();
    openContextMenu = undefined;
  }
  if (contextMenuKeyHandler) {
    document.removeEventListener("keydown", contextMenuKeyHandler);
    contextMenuKeyHandler = undefined;
  }
}

/**
 * Opens a small custom context menu at the given coordinates. Since
 * SortableTree doesn't have a native context menu concept, this is built
 * entirely by hand and appended to the document body (i.e. outside of the
 * tree itself, so it can't interfere with drag/click handling on nodes).
 * @param {{x: number, y: number}} position
 * @param {{label: string, action: string, danger?: boolean}[]} items
 * @param {string} name
 * @param {string} [nodeType]
 */
function openMenu(position, items, name, nodeType) {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "tv-context-menu";
  menu.style.left = `${position.x}px`;
  menu.style.top = `${position.y}px`;

  for (const item of items) {
    const menuItem = document.createElement("div");
    menuItem.className = "tv-context-menu-item" +
      (item.danger ? " tv-context-menu-item--danger" : "");
    menuItem.textContent = item.label;
    menuItem.addEventListener("click", (e) => {
      e.stopPropagation();
      closeContextMenu();
      performNodeAction(item.action, name, nodeType);
    });
    menu.appendChild(menuItem);
  }

  document.body.appendChild(menu);
  openContextMenu = menu;

  // Close on the next click anywhere, or on Escape.
  setTimeout(() => {
    document.addEventListener("click", closeContextMenu, { once: true });
    document.addEventListener("contextmenu", closeContextMenu, {
      once: true,
    });
  });
  contextMenuKeyHandler = (e) => {
    if (e.key === "Escape") {
      closeContextMenu();
    }
  };
  document.addEventListener("keydown", contextMenuKeyHandler);
}

/**
 * Initializes the TreeView's `SortableTree` instance.
 * @param {TreeViewConfig} config
 * @returns {SortableTree}
 */
function createTreeView(config) {
  const icons = config.nodeActions?.icons ?? {};

  return new SortableTree({
    nodes: config.nodes,
    disableSorting: !config.dragAndDrop.enabled,
    element: document.getElementById(config.treeElementId),
    stateId: TREE_STATE_ID,
    initCollapseLevel: 0,
    lockRootLevel: false,

    /**
     * @param {SortableTreeNode} movedNode
     * @param {SortableTreeNode} targetParentNode
     */
    confirm: async (movedNode, targetParentNode) => {
      const oldPrefix = movedNode.data.name;
      const newPrefix = targetParentNode ? `${targetParentNode.data.name}/${movedNode.data.title}` : movedNode.data.title;

      if (oldPrefix === newPrefix) {
        return;
      }

      const success = await syscall("system.invokeFunction", "index.renamePrefixCommand", {
        oldPrefix,
        newPrefix,
        disableConfirmation: !config.dragAndDrop.confirmOnRename,
      });

      if (success && config.currentPage.indexOf(oldPrefix) === 0) {
        // If this renamed the current page, navigate to it at it's updated name.
        await syscall("editor.navigate", config.currentPage.replace(oldPrefix, newPrefix), false, false);
      }

      return success;
    },

    onChange: async () => {
      await syscall("system.invokeFunction", "treeview.show");
    },

    /**
     * @param {SortableTreeNode} node
     */
    onClick: async (event, node) => {
      if (event.target.closest(".tv-node-actions")) {
        // Clicks on the hover action icons are handled separately and
        // should never trigger navigation.
        return;
      }

      if (node.data.nodeType === "attachment") {
        // Open attachment in new tab
        window.open(`/${node.data.name}`, "_blank");
      } else {
        await syscall("editor.navigate", node.data.name, false, false);
      }
    },

    /**
     * @param {SortableTreeNode["data"]} data
     * @returns {string}
     */
    renderLabel: (data) => `
      <span
        data-current-page="${JSON.stringify(data.isCurrentPage || false)}"
        data-node-type="${data.nodeType}"
        data-node-name="${escapeAttr(data.name)}"
        data-permission="${data.perm}"
        title="${data.name}" >
        <span class="tv-node-title">${data.title}</span>
        ${renderNodeActions(data, icons)}
      </span>`
    ,
  });
}

/**
 * Initializes the tree view and it's action bar.
 * @param {TreeViewConfig} config
 */
// deno-lint-ignore no-unused-vars
function initializeTreeViewPanel(config) {
  const tree = createTreeView(config);
  const treeElement = document.getElementById(config.treeElementId);

  const handleAction = (action) => {
    switch (action) {
      case "collapse-all": {
        document.querySelectorAll("sortable-tree-node[open='true']").forEach((node) => node.collapse(true));
        return true;
      }
      case "expand-all": {
        document.querySelectorAll("sortable-tree-node:not([open='true'])").forEach((node) => node.collapse(false));
        return true;
      }
      case "close-panel": {
        syscall("system.invokeFunction", "treeview.hide");
        return true;
      }
      case "refresh": {
        syscall("system.invokeFunction", "treeview.show");
        return true;
      }
      case "reveal-current-page": {
        const currentNode = tree.findNode("isCurrentPage", true);
        if (currentNode) {
          currentNode.reveal();
          currentNode.scrollIntoView({
            behavior: "auto",
            block: "nearest",
            inline: "nearest",
          });
          return true;
        }
        return false;
      }
      case "increase-width": {
        syscall("system.invokeFunction", "treeview.increaseWidth");
        return true;
      }
      case "decrease-width": {
        syscall("system.invokeFunction", "treeview.decreaseWidth");
        return true;
      }
      case "toggle-hidden": {
        syscall("system.invokeFunction", "treeview.toggleHidden");
        return true;
      }
      case "new-page": {
        createEntry("", false);
        return true;
      }
      case "new-folder": {
        createEntry("", true);
        return true;
      }
    }

    return false;
  }

  if (config.revealOnLoad) {
    handleAction("reveal-current-page");
  }

  document.querySelectorAll("[data-treeview-action]").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (handleAction(el.dataset["treeviewAction"])) {
        e.stopPropagation();
        e.preventDefault();
      }
    });
  })

  // Intercept clicks/mousedowns on the per-node action icons in the capture
  // phase, before SortableTree's own (bubble-phase) drag/click handling on
  // the node label ever sees them. This guarantees clicking an icon can
  // never be misread as the start of a drag or as a navigation click.
  const interceptNodeAction = (event) => {
    const actionEl = event.target.closest("[data-tv-action]");
    if (!actionEl) {
      return;
    }

    event.stopPropagation();
    event.preventDefault();

    if (event.type === "click") {
      performNodeAction(
        actionEl.dataset.tvAction,
        actionEl.dataset.tvName,
        actionEl.dataset.tvNodeType,
      );
    }
  };
  treeElement.addEventListener("mousedown", interceptNodeAction, true);
  treeElement.addEventListener("click", interceptNodeAction, true);

  // Right-click context menu: on a node, offer rename/delete/add-inside;
  // on empty tree space, offer creating new entries at the root.
  treeElement.addEventListener("contextmenu", (event) => {
    event.preventDefault();

    const nodeEl = event.target.closest("[data-node-type]");
    const position = { x: event.clientX, y: event.clientY };

    if (!nodeEl) {
      openMenu(position, [
        { label: "New page", action: "add-page" },
        { label: "New folder", action: "add-folder" },
      ], "");
      return;
    }

    const name = nodeEl.dataset.nodeName;
    const nodeType = nodeEl.dataset.nodeType;
    const items = [];
    if (nodeType !== "attachment") {
      items.push({ label: "New page here", action: "add-page" });
      items.push({ label: "New folder here", action: "add-folder" });
    }
    items.push({ label: "Rename", action: "rename" });
    items.push({ label: "Delete", action: "delete", danger: true });

    openMenu(position, items, name, nodeType);
  });
}

---
name: Library/joekrill/silverbullet-treeview
tags: meta/library
files:
- treeview.plug.js
---
# SilverBullet TreeView plug

This plugs adds a tree view that allows you to navigate your SilverBullet pages hierarchically.

Dragging-and-dropping files and folders is supported but requires SilverBullet v0.7.2 or greater. If running < v0.7.2, this feature will be automatically disabled (regardless of [configuration](#configuration)).

### Managing pages and folders

Hovering over a node reveals icons to add a page inside it, rename it, or delete it. Right-clicking a node (or empty space in the tree) opens a context menu with the same actions, plus creating a new folder. The toolbar also has buttons to create a new page or folder at the root. Deleting a folder deletes everything nested inside it and cannot be undone, so a confirmation is always shown first. Note that SilverBullet has no concept of an empty folder, so "New folder" creates a placeholder page at that path.

## Configuration

The treeview plug supports both SilverBullet v1 and v2, with the configuration being slightly different depending on
which version you are using.

In SilverBullet v2, this plug can be configured using the `config` object in your `CONFIG` page (default values shown):

```lua
config.set {
  plugs = {
    "github:joekrill/silverbullet-treeview/treeview.plug.js"
  },

  -- The treeview plug configuration
  treeview = {
    -- Determines where the panel is displayed:
    -- - "lhs" - left hand side
    -- - "rhs" - right hand side
    -- - "bhs" - bottom
    -- - "modal" - in a modal
    position = "lhs",

    -- Must be > 0.
    -- position = "lhs" | "rhs": determines the width of the panel.
    -- position = "modal": sets the margin around the modal window.
    -- position = "bhs": No effect
    size=0.5,

    dragAndDrop = {
      -- Set to false to disable drag-and-drop
      enabled = true,

      -- Set to false to disable the confirmation prompt shown when dragging and
      -- dropping pages that causes them to be renamed/moved.
      confirmOnRename = true
    },

    -- An array of exclusion rules that will exclude pages from being
    -- displayed in the sidebar.
    exclusions = {
      {
        -- Filter by regular expression:
        type = "regex",
        -- Regular Expression string to exclude pages from the tree
        -- Examples:
        -- - Any page that is all-caps: "^[A-Z]+$"
        -- - A specific set of pages: "^(?:CONFIG|Library|index).*$"
        -- - Any path containing Hidden (e.g. test/Hidden/page1): "Hidden"
        rule="^(?:CONFIG|Library|index).*$",
        -- Optional: set to true to negate the rule, only showing pages that match this regex.
        negate= false,
      },
      {
        -- Filter by page tags:
        type = "tags",
        tags = {"meta"},
        -- Optional: set to true to negate the rule, only showing pages that include any of the tags.
        negate = false
      }
    }
  }
}
```

Note: space functions are not supported in SilverBullet v2 yet, so the `space-function` exclusion type is not available.

### Adding a top bar toggle icon

![Screenshot](screenshot-action-button.png)

You can also add add a button to the top bar that will toggle the tree view.

This is done by adding the following `actionButton.define` in your `CONFIG` page:

```lua
actionButton.define {
  icon = "sidebar",
  description = "Toggle Tree View",
  run = function()
    editor.invokeCommand("Tree View: Toggle")
  end
}
```

# Review progress and repository rules

Enable `gitTreeCompare.showCheckboxes` to track reviewed files. Reviews survive
restarts, filtering, branch switches and rebases. The extension remembers the
**last explicitly approved fingerprint** for each repository, branch and file;
changes only affect whether that fingerprint currently matches. Checking a new
version replaces the approval, and explicitly unchecking clears it. Folder
checkboxes apply to all changed descendants, including collapsed children.

Fingerprints cover both sides of the comparison: exact file bytes, paths, Git
modes, symlink targets and submodule commits. Unrelated commits and timestamp-only
changes do not invalidate a review. Dirty or uninitialized submodules remain
unchecked until their changes are committed and their checkout is available. A different commit selection or comparison
base can legitimately show a file unchecked. Unsaved editor changes invalidate
checks immediately; save before marking a file reviewed. Restoring exactly the
approved comparison restores its check. “Hide reviewed files” reveals files again
when they change.

Progress is stored in VS Code extension storage, outside settings.json and Git.
When Settings Sync is enabled, review records are included. Clones and worktrees
with the same normalized `origin` URL and branch share progress; SSH and HTTPS
URLs match, while forks remain distinct. Repositories without a network `origin`
use local-only storage, shared between their linked worktrees. Detached HEAD
reviews are scoped to that commit. Renaming a branch or changing origin starts a
separate review identity; old records are retained.

Sync transfers hashed repository/branch/path keys, fingerprints and update
metadata, not file contents or remote credentials. Per-record timestamps merge
updates and preserve explicit unchecks; sync is eventual, not live collaboration,
and relies on reasonably accurate device clocks. Every machine validates its
own contents before displaying a synced check. Checkout transformations such as
CRLF conversion may conservatively require re-review. Remote extension hosts
use the storage and sync availability provided by that VS Code environment.

## Reduce review noise

Check in `.gitattributes` rules to apply a policy to the Git repository regardless
of which workspace folder is open:

```gitattributes
generated/** linguist-generated=true
vendor/** git-tree-compare-deemphasized=true
**/*.lock git-tree-compare-deemphasized=true
```

Git resolves these rules, including nested `.gitattributes`, global attributes
and `.git/info/attributes`. Bare attributes also mean true; `=false` or a leading
`-` clears that attribute. Use `directory/**`, not `directory/`, for descendants.
Rules are read from the current checkout even when filtering historical commits.

Matching files appear gray. Folders whose changed descendants all match start
collapsed and gray; mixed folders stay expanded unless the global collapsed
setting is enabled. Manually expanding a folder survives refreshes. These rules
never hide files or mark them reviewed automatically.

For additional patterns, add folder-scoped VS Code settings (which can also be
checked in as `.vscode/settings.json`):

```json
{
    "gitTreeCompare.deemphasizedPaths": ["vendor/**", "**/*.lock"],
    "gitTreeCompare.respectLinguistGenerated": true
}
```

Patterns are repository-relative, case-sensitive globs using `/` separators;
`**` includes nested directories and dotfiles are included. Settings apply per
VS Code workspace folder; nested repositories do not automatically load their
own `.vscode/settings.json`. Use attributes for that case. Set
`respectLinguistGenerated` to false to disable automatic generated-file styling.

Local files also offer **Open Containing Folder** in their context menu. The
command opens the desktop file manager; it is unavailable for remote-only or
missing files.


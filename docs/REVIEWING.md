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

Approving a file validates and saves that file without waiting for unrelated
agent edits or rehashing every previous approval. Folder approvals apply to each
child independently: a child changed during validation stays unchecked while
stable children can be approved. Branch and comparison changes still cancel
pending approvals, and the last approved hash is retained when a file changes.

Progress is stored in VS Code extension storage, outside settings.json and Git.
When Settings Sync is enabled, review records are included. Clones and worktrees
with the same normalized `origin` URL and branch share progress; SSH and HTTPS
URLs match, while forks remain distinct. Repositories without a network `origin`
use local-only storage, shared between their linked worktrees. Detached HEAD
reviews are scoped to that commit. Renaming a branch or changing origin starts a
separate review identity; old records are retained.

Sync transfers hashed repository/branch/path keys, fingerprints, reviewed commit IDs and update
metadata, not file contents or remote credentials. Per-record timestamps merge
updates and preserve explicit unchecks; sync is eventual, not live collaboration,
and relies on reasonably accurate device clocks. Every machine validates its
own contents before displaying a synced check. Checkout transformations such as
CRLF conversion may conservatively require re-review. Remote extension hosts
use the storage and sync availability provided by that VS Code environment.

## Changes since your last approval

A file whose comparison no longer matches its approval appears purple with a
**Changed since last review** tooltip. This colour takes precedence over generated
file dimming. **View Diff Since Last Reviewed** appears beside **Open File** and
**Discard Changes**, and in the file's context menu, when a commit baseline exists.
It opens VS Code's normal diff editor with the recorded commit on the left and
the working file on the right. Historical commit filters use the selected right
commit instead. Checking the file again replaces its fingerprint and baseline;
explicitly unchecking clears both. Restoring approved contents clears the colour.

For working-tree reviews the baseline is HEAD at approval time. For a historical
comparison it is the selected right commit. No file snapshots or extra Git commits
are created. Uncommitted changes that existed when you approved are also included
in the incremental diff; files absent at the recorded commit appear entirely
added. A changed PR base can require re-review while this incremental diff is
empty, since approval fingerprints cover both comparison sides. Renamed paths
have a separate review key, as before.

Commit baselines survive restarts, filters and branch switches, and sync with
review progress. Older approvals retain their checks and colour behaviour but
have no recorded baseline until approved again. If the commit is missing in a
different clone or was garbage-collected after a rebase, the action explains that
it is unavailable; it never silently substitutes HEAD or fetches automatically.

A small local index of reviewed paths keeps complete reverts visible in the full
comparison, even when they no longer differ from the PR base. These paths are not
synced; another machine can only retain paths indexed by its own approvals.
Explicit commit filters still limit the tree to their selected diff. After you
approve a complete revert, the next refresh removes it from the tree.

Customize the colour using `gitTreeCompare.changedSinceReviewForeground` inside
VS Code's `workbench.colorCustomizations` setting. Binary files and submodules
retain their usual VS Code limitations; the incremental action is for files,
not submodule directories.

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


## Send inline feedback to Orca

Hover a line and use the comment gutter **+**, or select a range and run
**Git Tree Compare: Add Orca Comment** (also in the editor context menu).
Orca comments are available on every line of local Git files, including
unchanged lines, ordinary editors, and either side of a Git diff. Expand hidden
unchanged sections before selecting them. If GitHub also offers comments there,
VS Code asks which provider to use; select **Orca Review**. The dedicated command
bypasses that provider picker.

**Send to Orca** submits your feedback with the exact Git worktree, relative file,
line range, revision information and a snapshot of the selected code. Unsaved
editor content is included and labelled. The extension finds the matching local
Orca workspace by path, prefers the selected agent in its tab layout, and otherwise
uses the first connected, writable terminal agent in visual order. Ordinary shells
and other worktrees are excluded. It focuses the destination after Orca accepts
the message. With multiple split editor groups, Orca's CLI does not expose keyboard
focus between groups; the first group's selected eligible agent wins.

**Save Note** keeps an editable note locally in this VS Code workspace. Saved notes
and delivery results survive reloads and are not synced to other machines. Text
still being composed must be saved explicitly. Notes keep their original code
snapshot; they do not automatically track lines across subsequent edits.

Failed sends retain an editable note. If delivery is uncertain (for example the
CLI connection is lost), the note remains visible but cannot be sent again from
that thread. Check Orca first; use **Copy Note** if you need to recover it manually.
An accepted message is never resent automatically, including when focusing the
pane fails. “Accepted; turn start unconfirmed” means Orca took the message but did
not report a started turn within ten seconds.

Install Orca's CLI and keep Orca running. `gitTreeCompare.orca.cliPath` optionally
sets the executable path in user settings (no arguments); otherwise discovery
uses `ORCA_CLI_COMMAND`, or `orca-ide` on Linux and `orca` on macOS/Windows.
`orca-dev` is used when `ORCA_DEV_REPO_ROOT` is present. Linux discovery never
launches the unrelated `orca` screen reader. Missing or incompatible CLIs produce
an error without downloading or installing anything.

This integration currently supports local terminal agents. Native Orca chat tabs,
Remote SSH/WSL VS Code windows, and Windows `.cmd` CLI wrappers are not supported.
Disable `gitTreeCompare.orca.enabled` and reload to remove the comment provider.

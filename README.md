# Git Tree Compare

Compare your working tree with a branch, tag or commit in VS Code. Browse changes
as a folder tree or flat list, open diffs, and track what you have reviewed—even
when an agent keeps editing files in the background.

- Preview branch and pull-request changes, with optional commit-range filtering.
- Keep review checkboxes across restarts, branch switches and rebases.
- Sync review progress between machines using VS Code Settings Sync.
- Dim generated files and collapse less important folders using repository rules.
- Compare linked Git worktrees and multiple repositories.

## Install

Requires VS Code 1.108 or later, Git, and a trusted workspace with the built-in Git
extension enabled.

Install a built `.vsix` through **Extensions → … → Install from VSIX…**. To build
and install from this checkout, install Nix with flakes enabled, then run:

```sh
cli/bin/run setup
cli/bin/run install
```

`install` builds the VSIX and uses VS Code's default profile. Add
`--profile 'Development'` to target a named profile, or use `package` to build
without installing. Artifacts and SHA-256 checksums are written to `artifacts/`.
See [development and distribution](docs/DEVELOPMENT.md) for prerequisites,
verification and GitHub release commands.

The extension ID is `bentefay.git-tree-compare`. Disable
`letmaik.git-tree-compare` in the same profile: both extensions use the same
command and view identifiers.

## Start a comparison

1. Open a Git repository and select **Git Tree Compare** in the activity bar.
2. Use **Change Base…** to choose a branch, tag or commit.
3. Select a file to open its diff. Use the context menu to open the file itself,
   copy its path, or open its containing folder on disk.
4. Use the view toolbar to search, refresh, or switch between tree and list views.

The default **merge** mode compares your working tree with its common ancestor
with the selected base, which is useful for reviewing a feature branch. **Full**
mode compares directly with the selected base. The chosen base is remembered per
repository.

You can open multiple diffs at once, or use **Open All Changes** for VS Code's
multi-file diff editor. **Discard Changes** restores files from the comparison
base; use it only when you intend to replace those changes.

## Track review progress

Enable review checkboxes in VS Code settings:

```json
{
    "gitTreeCompare.showCheckboxes": true
}
```

Check a file after reviewing it. Checking a folder approves its changed
descendants, including children that are collapsed. **Hide Checked Files** lets
you concentrate on the remaining work.

Each repository, branch and file retains its **last explicitly approved
fingerprint**. Edits make the checkbox unchecked without deleting that approval.
Restoring the same comparison restores the check. Branch switches, rebases and
filters retain progress; approving a new version replaces the fingerprint, and
explicitly unchecking clears the approval.

Fingerprints include both sides of the comparison, so a changed base can require
re-review even if your file is unchanged. Unsaved editor changes also invalidate
checks; save before approving a file.

Progress lives in VS Code extension storage and participates in Settings Sync.
Clones with the same normalized `origin` URL and branch share progress; each
machine validates its own contents before displaying a check. Repositories
without a network `origin` retain local progress. See
[review storage, sync and edge cases](docs/REVIEWING.md) for details.

## Collapse generated and low-priority changes

Add rules to the repository's `.gitattributes`:

```gitattributes
# Recognized by both GitHub and Git Tree Compare.
generated/** linguist-generated=true

# Only affects Git Tree Compare; GitHub diffs remain visible.
vendor/** git-tree-compare-deemphasized=true
**/*.lock git-tree-compare-deemphasized=true
```

Matching files appear gray. Folders containing only matching changes start
collapsed; mixed folders keep important files visible. You can expand a folder
at any time, and ordinary refreshes preserve that choice. These rules do not
mark files reviewed.

Git handles nested attribute files and overrides. Use `directory/**` to match
its contents; `directory/` is not recursive in `.gitattributes`.

You can also add repository-relative globs through VS Code folder settings:

```json
{
    "gitTreeCompare.deemphasizedPaths": ["vendor/**", "**/*.lock"],
    "gitTreeCompare.respectLinguistGenerated": true
}
```

A checked-in `.vscode/settings.json` applies when that directory is a workspace
folder. Use `.gitattributes` when rules must follow a Git repository regardless
of how its parent or subfolders are opened. [More about matching rules](docs/REVIEWING.md#reduce-review-noise).

## Commits, worktrees and GitHub pull requests

**Commits panel:** enable `gitTreeCompare.showCommitsPanel` to select a contiguous
range of commits, optionally including uncommitted changes. These selection
checkboxes filter the comparison; file checkboxes track review progress. A
historical comparison disables discard actions.

**Worktrees:** use **Change Worktree…** to compare another linked checkout without
adding it to the workspace. **Switch to Working Tree** returns to the workspace
checkout. With `multiRepositoryView` enabled, each repository node has its own
worktree selector.

**GitHub pull requests:** choose **Compare GitHub Pull Request…** from the view
menu, enter the PR URL, and authenticate when prompted. This fetches the PR and
checks out a local branch before comparing it with its base. The command requires
a clean working tree.

## Useful settings

Find all settings by searching for `gitTreeCompare` in VS Code Settings.

| Setting (`gitTreeCompare.…`) | Default | Purpose |
| --- | --- | --- |
| `showCheckboxes` | `false` | Track reviewed files and folders. |
| `showCommitsPanel` | `false` | Filter changes by a contiguous commit range. |
| `deemphasizedPaths` | `[]` | Additional globs for gray files and collapsed folders. |
| `respectLinguistGenerated` | `true` | Recognize generated-file attributes. |
| `diffMode` | `merge` | Compare against the common ancestor, or use `full`. |
| `viewMode` | `tree` | Show folders or a flat `list`. |
| `iconStyle` | `status` | Use Git status icons or the active `fileTheme`. |
| `showDiffStats` | `false` | Show insertion and deletion counts. |
| `multiRepositoryView` | `false` | Show multiple repositories together; experimental. |
| `autoRefresh` | `true` | Refresh the changed-file list automatically. |
| `root` | `workspace` | Use the workspace folder or entire `repository` as the root. |
| `compactFolders` | `true` | Combine folders with a single child. |
| `collapsed` | `false` | Start all folders collapsed; reload after changing. |

Review validation remains active when `autoRefresh` is disabled. Filesystem and
editor events detect edits; startup, focus and manual refresh catch missed
changes. The old `resetCheckboxOnFileChange` setting is deprecated because review
checks now always validate content.

## Development

```sh
cli/bin/run check     # Type checking and fast regression tests
cli/bin/run verify    # Build, extension-host tests, packaged UI tests and audit
```

The pinned Nix/devenv environment includes Safe Chain dependency protection.
Direnv is optional. Automated Linux editor tests run on a private Xvfb display.

- [Development, testing and distribution](docs/DEVELOPMENT.md)
- [Review behavior and repository rules](docs/REVIEWING.md)
- [Security review](docs/SECURITY-REVIEW.md)
- [Changelog](CHANGELOG.md)

Based on [Git Tree Compare by Maik Riechert](https://github.com/letmaik/vscode-git-tree-compare).
Licensed under the [MIT License](LICENSE).

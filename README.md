# Git Tree Compare

Compare your working tree with a branch, tag or commit in VS Code. Browse changes
as a folder tree or flat list, open diffs, and track what you have reviewed—even
when an agent keeps editing files in the background.

- Preview branch and pull-request changes, with optional commit-range filtering.
- Keep review checkboxes across restarts, branch switches and rebases.
- Highlight files changed since approval and compare them with the last reviewed commit.
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
   Folder context menus also offer **Open Containing Folder** to reveal the selected
   folder in your system file manager.
4. Use the view toolbar to search, refresh, or switch between tree and list views.

Right-click an editor or its tab and choose **Reveal in Git Tree Compare View**
to select that file in the tree and expand its parent folders. The action appears
only for files included in the current comparison and filters, including files
inside collapsed folders. Choose **Open Git Tree Compare Diff** in the same menu
to select the file and open its changes against the current comparison base.
Both actions also work from Git diff editors.

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
Restoring the approved contents restores the check. Branch switches, rebases and
filters retain progress; approving a new version replaces the fingerprint, and
explicitly unchecking clears the approval.

New approvals fingerprint the reviewed file independently of the comparison base,
so switching review rounds preserves checks for unchanged contents. Older approvals
keep their original semantics until you approve again. Unsaved editor changes
invalidate checks; save before approving a file.

Files changed since approval turn purple. **View Diff Since Last Reviewed**,
beside the file's other actions and in its context menu, opens **Last reviewed
commit ↔ Working tree** in VS Code's normal diff editor. Approving again updates
the baseline and clears the highlight. The colour can be customized with
`gitTreeCompare.changedSinceReviewForeground` in `workbench.colorCustomizations`.

The baseline is the commit at approval time, not a snapshot of uncommitted
contents. Any edits already uncommitted when you approved are also included in
this diff. Existing approvals need a new approval to record a commit baseline.

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

**Compare From** and **PR Commits** start collapsed; VS Code remembers your
expansion choices. Compare From offers review checkpoints, the branch merge-base,
and local/remote target branch tips. Click a candidate or a PR commit to compare
that exact commit with the working tree. The PR timeline stays anchored to the
target branch even when the selected comparison base changes. **Reset Comparison
Base** returns to the normal comparison.

Review checkpoints record when files were checked, not whole-commit approval.
They survive later approvals, branch switches and rebases, and sync with review
progress. Missing commits stay listed as unavailable. Selecting a base does not
check out a branch or fetch. Branch tips refresh when you open a pane or use its
Refresh action; selecting a tip pins its displayed commit until you choose again.

**Commit Range pane:** enable `gitTreeCompare.showCommitsPanel` to select a contiguous
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

## Inline feedback to Orca

Select lines in a local Git file or diff and run **Git Tree Compare: Add Orca
Comment**, or use the gutter **+** and choose **Orca Review**. Comments work on
unchanged lines too. **Send to Orca** sends the note and code context to an agent
in the matching Orca worktree, then focuses it. **Save Note** keeps a local draft.
Requires Orca's CLI and a running terminal agent; native chat tabs are not yet
supported. See [Orca review notes](docs/REVIEWING.md#send-inline-feedback-to-orca)
for target selection, setup and delivery behaviour.

## Useful settings

Find all settings by searching for `gitTreeCompare` in VS Code Settings.

| Setting (`gitTreeCompare.…`) | Default | Purpose |
| --- | --- | --- |
| `orca.enabled` | `true` | Enable inline comments for Orca terminal agents. |
| `orca.cliPath` | Automatic | Override the Orca CLI executable in user settings. |
| `showCheckboxes` | `false` | Track reviewed files and folders. |
| `showCommitsPanel` | `false` | Show the optional Commit Range filter, alongside the review panes. |
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

## Agent-assisted review

Use the bundled **enrich-pr** skill with a locally checked-out PR to add three
complementary views from one analysis:

- **File labels and explanations:** important/plumbing/tests/whitespace labels in
  the existing tree, plus collapsed, read-only explanations on exact code ranges.
- **Review Guide:** a pane that starts collapsed, with a suggested reading order
  and linked explanations covering every important file. Expand a step to open
  its individual file/range targets; titles are numbered once by the UI.
- **Review Brief:** an on-demand overview with linked flow diagrams or code
  sketches, the full guide, review focus, evidence, unknowns and filterable file cards. Open it from the view menu or Command Palette.

Attention is independent of the type of change: **important**, **normal**, or
**low attention**. The tree uses text labels and keeps its normal file/status
icons. The Review Brief colours important and low-attention tags. Existing
purple changed-since-review filenames remain visible.
Labels can be combined: a generated schema can be important. **Plumbing** means
routine parameter/field forwarding or repetitive call-site changes; its guide
should link to the substantive decision elsewhere. Labels do not approve files.

Guide steps can link to several related diffs, including exact before/after line
ranges or inline explanations. Every important file must have a guide link;
validation rejects incomplete coverage. The brief also links claims and flow
steps directly to their supporting diffs. Old analyses remain readable, including
previously numbered titles.

Install the skill from this source checkout:

```sh
cli/bin/run skills install --global
```

This uses the pinned `skills` package for Codex and Claude Code. Select just one
with `--agent codex` or `--agent claude-code`; preview with `--dry-run`. Keep this
checkout available because the skill invokes its CLI. Restart the agent if needed
to discover the new skill, then ask it to **enrich the current PR** using
`enrich-pr` (`$enrich-pr` in Codex, `/enrich-pr` in Claude Code).

Choose the comparison in Git Tree Compare first. The skill captures that exact
selection, reads the changes, validates its JSON and publishes it locally. If
it cannot write to the Git directory, use **Git Tree Compare: Import Enrichment
JSON**. No model runs automatically inside the extension.

New edits mark previous analysis out of date and remove stale line explanations.
Returning to unchanged content restores matching notes. Labels never approve or
hide files and preserve the existing changed-since-review color. Use **Toggle
Review Explanations** to hide inline notes while keeping the guide and labels.
Enrichment is stored in the worktree's Git directory, so it adds no tracked files
and needs no ignore rule. It stays local; review checkbox sync is unchanged.

See [the enrichment CLI documentation](docs/DEVELOPMENT.md#agent-enrichment) for
explicit base selection, the JSON schema, validation and storage details.

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

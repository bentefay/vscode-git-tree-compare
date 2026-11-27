# Development and distribution

## Setup

Install Nix with flakes and `nix-command` enabled. Direnv is optional; configure
its shell hook, review `.envrc`, then run `direnv allow`. Without direnv every
`cli/bin/run` invocation enters the same environment automatically:

```sh
cli/bin/run setup
cli/bin/run doctor
cli/bin/run verify
```

The bootstrap pins devenv 2.4.0 through a Nixpkgs revision. `devenv.yaml` and
`devenv.lock` pin the module and package inputs. Node 24, Git, GitHub CLI, Safe
Chain 1.5.29, packaging utilities and Linux display/runtime libraries come from
that environment. No global profile or shell configuration is changed.

This follows `~/Code/cosmos`: `.envrc` loads devenv, Nix supplies wrappers, and
`cli/bin/run` dispatches to small Clipanion command classes with shared helpers.
Here the CLI uses the extension's locked Node installation, rather than adding
Cosmos's Bun runtime. Cosmos's older Node version was not copied.

## Commands

| Command (`cli/bin/run …`) | Result |
| --- | --- |
| `setup` | `npm ci --ignore-scripts`, then environment checks |
| `doctor` | Tool versions, Safe Chain integration and Nix revision |
| `check` | TypeScript and fast Node regression tests |
| `build` | Development bundle in `dist/` |
| `test unit` | Fast regression tests |
| `test integration` | Real extension-host tests on both pinned VS Code versions |
| `test ui` | Build/install the VSIX into an isolated editor and test its UI |
| `verify` | Doctor, typecheck, regression tests, build, integration, package, UI, audit |
| `dependencies verify` | Malware blocking probe, fresh-cache locked install and audit in a disposable directory |
| `package` | Production VSIX and SHA-256 in `artifacts/` |
| `release --tag TAG` | Full verification, then a new GitHub release with VSIX and checksum |
| `install` | Build and install the extension into local VS Code |

After direnv loads, `run` is shorthand for `cli/bin/run`. Use `--help` on any
command. The wrapper remembers the invocation directory, so relative `--vsix`
paths work even when invoked outside the repository.

## Build and publish to GitHub

Update the extension version and changelog, commit, and push the intended commit
to this repository. Authenticate `gh` yourself. Preview the destination and arguments:

```sh
cli/bin/run release --tag v1.22.0 --draft --dry-run
cli/bin/run release --tag v1.22.0 --draft
```

Omit `--draft` for a public release. The command derives the destination from
`origin`, requires a clean checkout and a commit already present on GitHub,
rejects an existing remote tag, runs `verify`, and checks the checkout again.
It then creates a release/tag at that exact commit and attaches the VSIX and
checksum. It never implicitly pushes commits or publishes to Marketplace.
Changing a tag or rerunning after a partial release needs deliberate review;
the command does not overwrite existing releases.

## Install locally

```sh
cli/bin/run install --dry-run
cli/bin/run install --profile 'Git Tree Compare Development'
cli/bin/run install --vsix artifacts/git-tree-compare-1.21.0.vsix --force
cli/bin/run install --code /path/to/code-insiders --profile 'Development'
```

The default executable is `code`. `--vsix` installs an already built artifact;
otherwise the command builds first. Identity and package contents are checked
before installation. `--force` explicitly allows replacement. Reload VS Code
when prompted. Disable the upstream extension in the selected profile: the
extension has its own publisher ID but shares command, view and setting identifiers.

## Agent feedback loop

1. Run `check` during edits. These tests cover bounded file statistics, revision
   input and CLI behavior.
2. Run `test integration` for activation, actual Git operations, tree state,
   command completion, diff editors and Workspace Trust. Microsoft’s
   `@vscode/test-cli` / `@vscode/test-electron` run tests in the real host.
3. Run `test ui` for the distributed artifact. ExTester and a matching
   ChromeDriver open an isolated VS Code with the packaged extension installed.
   The tests open a diff editor, inspect generated-file styling and context menus, and verify review persistence across a full editor restart. The launcher restores the same disposable profile after ExTester resets its settings directory; it never uses the personal editor profile. Extension-host test mode intentionally uses in-memory VS Code storage, so persistence is verified in the packaged UI layer. Screenshots and workbench HTML are recorded.
4. Inspect `test-results/` and fix failures. Run `verify` for the final check.
   CI runs the same command and uploads the VSIX and diagnostic evidence.

VS Code 1.108.0 is the minimum manifest version; 1.145.3 is the current version
pinned when this setup was researched on 2026-11-11. Archive URLs and SHA-256
hashes, including ChromeDriver, live in `test/runtime-lock.json`. Downloads are
verified before extraction; cached archives are rechecked. Linux executables
are patched to use pinned Nix libraries without changing global LD_LIBRARY_PATH.

Every host run gets a fresh repository, Git configuration, disabled hooks,
user-data, shared-storage and extensions directory. Runtime directories use
short temporary paths to avoid Unix socket path limits; they are copied into
`test-results/` on completion or failure. Common GitHub/editor credentials and SSH
agent variables are removed from test subprocesses. Tests never clone a private
repository. On Linux a private Xvfb, D-Bus session and Openbox provide focus and
display isolation. Wayland variables and desktop activation tokens are removed;
Electron is forced to X11 so automated windows stay off the user's desktop.
The UI test asserts the private display's dimensions. Electron sandboxing is disabled in this automation harness;
this is test isolation, not a security boundary for hostile extension code.
Run untrusted code in a disposable machine/container without secrets.

Linux x64 is the CI platform. The lock also includes macOS x64/ARM archives and
Linux ARM VS Code; macOS requires a logged-in GUI session for UI tests. Linux
ARM supports integration tests but the UI command fails explicitly because
Google does not supply a matching Linux ARM ChromeDriver. Windows development
is not configured by this Nix environment. F5 uses your installed VS Code with
isolated debug profiles; the automated loop uses the locked versions instead.

## Dependency maintenance

The Nix npm wrapper routes installs, registry requests and audits through Aikido
Safe Chain. A 48-hour minimum package age is enforced. `npm exec`/`npx` and other
package managers are blocked to keep tools declared and locked; ordinary
`npm run` executes installed tools and preserves the protected PATH for nested
npm calls. `.npmrc` and `--ignore-scripts` disable dependency lifecycle scripts. The explicit
build/prepublish scripts are still run when packaging.

Safe Chain detects known malware in downloads; it is not a vulnerability audit,
code sandbox or guarantee about previously cached packages. `dependencies verify`
tests its harmless `safe-chain-test` blocking fixture and then performs an
install with a fresh cache. A normal `verify` includes `npm audit` and fails on
moderate or higher advisories. Availability of registries/scanning services is
required; checks fail rather than silently downgrading protection.

`package.json` overrides patched `glob` (14.0.4), `minimatch` (11.0.1),
`serialize-javascript` (7.1.4) and `diff` (8.0.4) because the current test and
packaging tools still request vulnerable older major versions. Overrides apply
only to affected glob/minimatch/diff ranges, preserving legacy callable APIs.
Exercise packaging and both test layers when changing these overrides; remove
them once upstream ranges are fixed.

To update packages, enter devenv, edit declared versions, run
`npm install --ignore-scripts`, inspect the lockfile and run `verify`. Update
the Nixpkgs revision in both `scripts/devenv` and `devenv.yaml`, regenerate
`devenv.lock`, and test a fresh environment. Update runtime archives from the
official VS Code release metadata and Chrome for Testing distribution, record
their hashes and run both test layers. Hashes pin what was reviewed; they do not
independently establish publisher trust. VSIX ZIP timestamps mean this setup
does not promise byte-for-byte reproducible release archives.

## Research sources

- [VS Code extension tests](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [VS Code continuous integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration)
- [Microsoft test CLI](https://github.com/microsoft/vscode-test-cli)
- [ExTester](https://github.com/redhat-developer/vscode-extension-tester)
- [ChromeDriver version selection](https://developer.chrome.com/docs/chromedriver/downloads/version-selection)
- [devenv with direnv](https://devenv.sh/integrations/direnv/)
- [Aikido Safe Chain](https://github.com/AikidoSec/safe-chain)
- [VS Code packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

These informed the layered loop: fast regression tests, real host integration,
then a small packaged UI smoke test. Playwright's Electron support remains
experimental; ExTester's VS Code page objects are the narrower fit here.

## Agent enrichment

`cli/bin/run skills install --global` installs the bundled `enrich-pr` skill for
Codex and Claude Code through the same pinned `skills@1.5.26` used in Cosmos.
Use `--agent codex` or `--agent claude-code` to select one, and `--dry-run` to
preview. The installer copies a helper containing this checkout's absolute CLI
path. Keep the checkout available; reinstall the skill after moving it. No ad
hoc package download is involved. Skill installation is a separate user action
from building or installing the VSIX.

The editor exports its current comparison selection in the background. The CLI
always takes an explicit target via `--repo` (otherwise it uses the original
invocation directory, before the launcher enters this repository):

```sh
cli/bin/run enrich context --repo /path/to/checkout --out /tmp/review-context.json
cli/bin/run enrich schema
cli/bin/run enrich validate --repo /path/to/checkout --file /tmp/enrichment.json
cli/bin/run enrich publish --repo /path/to/checkout --file /tmp/enrichment.json
```

Without an editor selection, pass `--base <ref>` and optionally `--right <ref>`.
These are exact endpoints, resolved to commits; the command does not silently
calculate a merge-base or guess a default branch. A missing right endpoint means
the working tree. The context includes paths, both-side identities and a snapshot
ID. The agent supplies explanations, not hashes. `shared/enrichment.schema.json`
describes the JSON structure; the shared validator also checks actual paths,
line bounds, blob contents, whitespace claims and snapshot freshness. Invalid
publication leaves the previous pointer intact.

The shared core runs directly in the CLI and in a dedicated worker in the
extension. The extension host renders cached labels; it performs no synchronous
Git calls or source-file reads. Existing repository/document events schedule
coalesced checks. A narrow watcher on the worktree's enrichment publication
pointer directory discovers completed runs. It does not watch the source tree.
Native explanations are created only for visible documents, remain read-only,
and start collapsed. Guide navigation expands the selected explanation. The
Review Brief webview is created only on request.

State lives under the resolved per-worktree Git directory at
`git-tree-compare/enrichment/v1`: immutable `snapshots/` and `runs/`, atomic
`current/` pointers, and `selection.json`. Linked worktrees have separate storage.
Runs survive branch changes; changing base selects a different publication.
Returning to identical content restores matching file explanations. HEAD or
comparison changes invalidate comparison-scoped explanations. File-scoped notes
survive unrelated changes, but never attach to edited or dirty file versions.
No enrichment automatically checks a review checkbox or hides a file.

Snapshots and runs are local and retained until manually removed; they are not
synced with review approvals. A result is limited to 2 MiB, 2,000 files, 200 notes
and 100 guide steps, with at most 500 diff links. Binary, oversized and non-regular files can receive summaries,
but cannot receive code annotations. No server, model API or credentials are
required. If an agent's sandbox cannot publish into the Git directory, it can
write validated JSON to an allowed location; use **Import Enrichment JSON** in
the extension. The import validates freshness again.


### Enrichment format version 2

`enrich schema` describes the current authoring format. Snapshot/storage versions
stay at 1; new analysis documents use version 2. Version 1 analyses remain readable
and publishable for existing installed skills. They are adapted in memory to the
new UI without rewriting immutable history or inventing coverage. Newly authored
version 2 results must link every important file from at least one guide step.

A file has independent `priority` (`important`, `normal`, `low`), one to four
`labels`, a reason and optional annotations. `plumbing` describes mechanical
propagation of a change and usually receives low attention; it never forces that
priority. Generated content, tests and configuration can all be important.
Whitespace claims remain content-validated. The main tree shows at most two tags
plus a stale marker; tooltips and the brief show all labels. Enrichment preserves
the tree's normal file/status icons and last-review filename colours. Attention
colours apply only to Review Brief tags; theme authors can customise important
tags with `gitTreeCompare.importantForeground`.

Guide steps contain an unnumbered title, an explanation and 1–12 labelled diff
links. Each link targets a listed file and optionally an annotation index or an
explicit 1-based inclusive before/after range, never both. Native steps expand to
individual links; clicking the step opens its first target. The UI also removes
leading numeric prefixes from old agent titles. Range links are validated against
the actual content, and stale/dirty ranges open a whole-file diff without using
old anchors. Commands from superseded publications are ignored.

The brief adds linked `focus`, `evidence` and `unknowns` entries, plus up to three
small visuals: linked flow steps, a text tree, pseudocode or a diff sketch. These
are bounded data rendered by the extension, with no arbitrary HTML, external
resources, executable Markdown or diagram runtime. Guide explanations and their
links are visible together. Filters match any label as well as attention.

The bundled skill contains the writing guidance and a complete linked example
under `skills/enrich-pr/references/example.json`. The CLI tests validate that
example against real disposable Git content. Global skill installation copies
references along with the launcher; rerun the installer to update installed skills.


## Automatic comparisons and review reset

Automatic and manual target choices are separate (`baseRefMode_<root>`). Legacy
saved default targets migrate to automatic; custom targets and pinned review bases
remain selected. Ref checks resolve target tips to commits and detect updates even
when HEAD does not move. Automatic comparisons always use the merge-base; an explicit
Full Diff action selects the current target tip. Native tree labels show the target
name only when it is the actual base, otherwise the merge-base's short SHA.

`gitTreeCompare.clearReviewState` captures the selected checkout before showing its
confirmation. It invalidates in-flight approvals, drains the checkbox queue, removes
that worktree's enrichment through the worker, and writes an opaque repository reset
boundary (`reviews.resets.v1`, with a local mirror). Review/history reads exclude
records at or before that boundary, across all branches. Merge metadata and old opaque
records may remain as tombstones; stale/offline snapshots must not resurrect progress.
Reset metadata syncs only for portable repository identities. A nonce invalidates
saved comparison bases for every branch of the selected worktree. Other repositories'
records and selections are unaffected. No source file, index or Git ref is changed.

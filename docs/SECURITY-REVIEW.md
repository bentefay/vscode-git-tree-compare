# Repository review, 2026-11-11

## Scope and conclusion

Reviewed all 43 tracked files at
`f8a7015b7b6d64238adbc6e7f02e11f7a8c4dbcf` before executing repository code:
TypeScript, vendored Git helpers and declarations, manifest, webpack/TypeScript
configuration, CI, editor configuration, documentation, license and assets.
Text was read, raster assets decoded/inspected, SVG content checked and Git
object integrity checked with `git fsck`. This was a source review of that tree,
not an exhaustive audit of every historical commit or dependency source file.

No obvious malicious payload, embedded credential, dynamic-code loader or
unexpected install hook was found. That does not establish that the extension
or its dependency graph is universally safe. The extension intentionally runs
Git, can discard changes and switch branches, uses GitHub authentication for PR
comparison, and can launch a configured external difftool. Only enable it in
repositories you trust.

The important issues found were concrete Git argument handling hazards and a
development environment with floating dependencies and no executable tests.

## Findings addressed in this change

| Finding | Evidence / correction |
| --- | --- |
| Filename interpreted as a Git pathspec during restore/removal | A disposable repository reproduced `*.txt` selecting another file. File checkout and removal now use global `--literal-pathspecs` plus `--`; real Git regression tests preserve edits in the unrelated file. |
| Custom revision interpreted as a `git show` option | `--output=PATH` could create an arbitrary output file. User input is validated, resolved with `rev-parse --verify --end-of-options …^{commit}`, then only the resolved commit ID is passed to `show`. Regression tests reject the option and check no file was written. |
| “Unshallow” could merge/rebase | The fallback called the Git API's `pull(true)`. It now executes `fetch --unshallow` against the selected remote, with cancellation, and leaves branch integration to the user. |
| PR cleanliness check failed open | An exception checking worktree status was logged but PR mutation continued. It now reports the failure and returns. The existing base remote's actual name is used instead of hardcoded `origin`. |
| Commands completed before their work | Command callbacks now return their promises; single-file discard, progress and multi-file opening are awaited. Activation awaits initialization instead of a detached timer. |
| Untracked statistics could read links or unlimited data | Reads skip symlinks/special files, use no-follow/nonblocking opening where supported, cap each read at 1 MiB, and cap concurrency at eight. Tests cover ordinary text, binary, links, missing files and large files. |
| Manifest claimed untrusted-workspace support | Support is now disabled, matching the required built-in Git extension. Activation also checks trust. |
| Dependency/CI drift | npm lockfile committed; Nix/devenv, Safe Chain, VS Code and ChromeDriver pinned; install scripts disabled; CI uses SHA-pinned actions with read-only contents permission and no persisted Git credentials. |
| Packaging tooling advisories | Old vsce was replaced. Current tooling required explicit patched transitive overrides; the resulting audit reported zero advisories at setup time. Keep auditing because that result is time-dependent. |

The original CI built and uploaded a VSIX as a workflow artifact; it did not
publish to Marketplace. New CI retains that separation. Publishing is an
explicit CLI operation targeting `origin`, after verification.

## Remaining boundaries

- PR comparison intentionally fetches remotes and checks out a branch. It is
  not a read-only preview. Discard commands intentionally modify files.
- Trusted repository configuration can cause Git to execute hooks, filters,
  credentials helpers and external difftools. Workspace Trust does not sandbox
  these tools. Tests override hooks/configuration in disposable repositories.
- The broad tree provider and copied Git implementation still need ongoing
  regression coverage, particularly multi-repository/worktree interactions,
  remote authentication and cancellation. A smoke suite is not full coverage.
- Safe Chain screens package downloads for known malware. Cache hits and
  already installed code are a separate trust boundary. npm audit checks known
  advisories, not intent. The dependency verification command uses an empty
  cache to exercise the download path.
- VS Code/ChromeDriver archives come from their publishers over HTTPS and are
  checksum-pinned. This is controlled acquisition, not a source-built Electron
  toolchain. The test profile is disposable; the surrounding machine still
  supplies its kernel, filesystem and network.
- Release commands require GitHub access. Tests use dry runs and subprocess
  substitutes; this setup does not publish a release or install into the user's
  personal editor as part of verification.

## Sources for the setup decisions

See [development research and workflow](DEVELOPMENT.md). Relevant advisory
records for the transitive overrides are
[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249),
[glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4),
[serialize-javascript](https://github.com/advisories/GHSA-5c6j-r48x-rmvq) and
[diff](https://github.com/advisories/GHSA-73rr-hh4g-fpgx).

## Validation performed

On Linux x64: TypeScript and shell checks; seven fast regression/CLI tests;
six trusted-host tests plus one untrusted-workspace test on each of VS Code
1.108.0 and 1.145.3; production VSIX inspection; and a packaged UI smoke test.
The UI screenshot was inspected and the test asserts the private Xvfb display.
The final headless configuration removes inherited Wayland access after early
harness runs revealed it could bypass Xvfb. The latest VS Code also needed an
explicit shared-storage location outside the user's normal editor data.

Safe Chain blocked its harmless test package, and a fresh-cache locked install
and audit reported zero vulnerabilities. Direnv activation and the standalone
devenv bootstrap were exercised. Release behavior was tested through dry runs
and refusal checks; installation used an inert VSIX and a substitute editor.
No GitHub release was published and no extension was installed into the user's
personal editor profile. macOS/ARM execution and remote GitHub Actions have not
been exercised from this Linux session.

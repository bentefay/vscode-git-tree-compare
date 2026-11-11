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

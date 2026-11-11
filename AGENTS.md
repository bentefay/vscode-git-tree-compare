# Working in this repository

This repository contains the Git Tree Compare extension. Read `docs/DEVELOPMENT.md`
and `docs/SECURITY-REVIEW.md` before changing the development environment or Git
operations. The extension entry point is `src/extension.ts`; `treeProvider.ts`
owns comparisons and tree state; `commitsProvider.ts` owns commit selection.
`src/git/` is adapted VS Code Git code: preserve its copyright notices.

## Environment and commands

- Use `cli/bin/run setup` on a fresh checkout. The launcher enters the pinned
  devenv automatically. With direnv enabled, `run` is available directly.
- Use `cli/bin/run check` for fast type and regression checks, then
  `cli/bin/run verify` before handing off a change. For a failed layer use
  `cli/bin/run test unit`, `test integration`, or `test ui`.
- Keep `package-lock.json`, `devenv.lock`, and `test/runtime-lock.json` committed.
  Install through the protected `npm` in devenv with `--ignore-scripts`.
  Declare new tools in package.json; do not use ad hoc npx/npm exec downloads.
  Do not bypass Safe Chain or its minimum package age to fix an install failure.
- CLI command classes live in `cli/commands`; reusable operations live in
  `cli/lib`. Preserve argument arrays when spawning processes. Do not construct
  shell commands from filenames, refs, tags, URLs, or profile names.

## Closed-loop verification

Use the disposable repositories and editor profiles created by the test harness.
Do not run discard, checkout, PR comparison, or installation experiments against
the user's repository or normal editor profile. Integration tests exercise the
minimum and pinned current VS Code; UI tests install the actual VSIX.

Inspect `test-results/` after a failure: Mocha JSON, VS Code logs, ChromeDriver
logs, screenshot and workbench HTML. Fix the cause and rerun the affected layer;
then run `verify`. Do not replace an assertion with a fixed delay or silently
skip a failing platform. Report any untested platform explicitly.

For Git changes, include an observable regression test using a real disposable
repository. Treat filenames as literal pathspecs, resolve user revisions to
commit IDs before use, await command work, and fail closed on cleanliness errors.
For view changes, inspect the screenshot from the packaged UI test as well as
its exit status. Linux headless tests deliberately run under a private Xvfb and
window manager because focus affects refresh behavior.

## Distribution

`cli/bin/run package` creates a local VSIX and checksum. `release --dry-run` and
`install --dry-run` describe external actions. Implementing or testing these
commands does not itself authorize publishing a release or changing the user's
editor. When the user asks to publish/install, use the commands as documented;
do not publish to the upstream repository or Marketplace by accident.

The extension ID is `bentefay.git-tree-compare`, and it retains upstream
command/view identifiers. Disable the upstream extension in any profile that
enables this extension.

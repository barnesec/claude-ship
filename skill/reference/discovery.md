# Discovering a repo's checks

The run's definition of done: the branch passes typecheck and lint, builds successfully, and every test related to the changed code passes. checks.json records how this repository does each of those. The Stop gate runs exactly these commands, so they must be real for this repo.

## checks.json format

```json
{
  "version": 1,
  "notes": "Expo app, npm. Found via package.json scripts.",
  "checks": [
    { "id": "typecheck", "cmd": "npx tsc --noEmit" },
    { "id": "lint", "cmd": "npm run lint" },
    { "id": "build", "cmd": "npx expo export --platform web --output-dir {tmp}", "timeoutSec": 1200 },
    {
      "id": "tests",
      "cmd": "npx jest --ci --findRelatedTests {files} --passWithNoTests",
      "fallback": "npx jest --ci",
      "match": "\\.(?:[cm]?[jt]sx?)$"
    }
  ]
}
```

Fields:
- `id`: required ids are `typecheck`, `lint`, `build` and `tests`. Add more checks with other ids if the repo has them, such as `format` or `test-e2e`.
- `cmd`: the shell command, run from the repo root (or from `cwd`). Exit code 0 means pass. Commands run with `CI=1`, in bash: `/bin/sh` on macOS and Linux, and Git Bash on Windows (the same shell as Claude's Bash tool). Only when Git Bash can't be found on Windows do they fall back to cmd.exe, so prefer plain commands that work in both: no `VAR=value` prefixes, single quotes or `/dev/null`.
- `skip`: instead of `cmd`, a reason of at least 10 characters when a check genuinely doesn't apply, such as `"no build step: library consumed as TypeScript source"`. Skips appear in the PR.
- `{files}`: replaced with the changed files (since the run's base commit) that match `match`, relative to `cwd`. When no changed file matches, the check passes as "nothing related to test".
- `fallback`: run instead of the `{files}` form when the changed-file list is too long for one command line.
- `{base}`: replaced with the run's base commit sha, for tools with a "changed since" option.
- `{tmp}`: replaced with a quoted scratch directory outside the repo. Use it for build output so builds never leave files in the working tree.
- `match`: regex for which changed files count. The default is JS/TS sources.
- `cwd`: a relative directory to run in (monorepo packages).
- `timeoutSec`: default 900.

## Where to look

1. **Package manager:** from the lockfile: `package-lock.json` = npm, `yarn.lock` = yarn, `pnpm-lock.yaml` = pnpm, `bun.lockb` or `bun.lock` = bun. Use the matching runner (`npx`, `yarn`, `pnpm exec`, `bunx`) and `<pm> run <script>`.
2. **Scripts first:** prefer the repo's own scripts in package.json (`typecheck`, `type-check`, `tsc`, `lint`, `build`, `test`), Makefile targets or CI workflow steps (`.github/workflows/*.yml`). CI shows what the team actually considers green.
3. **Typecheck:** no script but a `tsconfig.json` → `npx tsc --noEmit` (`npx tsc -b` for project references). Plain JavaScript with no type checking → skip with a reason.
4. **Lint:** an ESLint config (`eslint.config.*`, `.eslintrc*`, or `eslintConfig` in package.json) → `npx eslint .`. Biome (`biome.json`) → `npx biome check .`. No linter → skip with a reason.
5. **Build:** the `build` script if there is one. Otherwise, pick the fastest faithful compile of the app:
   - Expo: `npx expo export --platform web --output-dir {tmp}` if web is configured; otherwise `npx expo export --platform android --output-dir {tmp}`.
   - Bare React Native: `npx react-native bundle --platform android --dev false --entry-file index.js --bundle-output {tmp}/index.android.bundle`.
   - Native Gradle or Xcode builds are slow and need local toolchains: use them only if the repo's CI does and they run here.
   - Vite, Next.js, webpack and similar: the framework build command.
   Send build output to `{tmp}` when the tool lets you choose, never into the working tree.
6. **Tests:** Jest → `npx jest --ci --findRelatedTests {files} --passWithNoTests` with a full-suite fallback. Vitest → `npx vitest related {files} --run --passWithNoTests` with fallback `npx vitest run`. No related-test support → run the full suite. No tests at all → skip with a reason.
7. **Monorepos:** use workspace-aware commands (`npm run lint --workspaces --if-present`, `pnpm -r lint`, `turbo run lint`), or one check per affected package with `cwd`.
8. **Other stacks:** Python (`mypy` or `pyright`, `ruff check`, `pytest` with `--lf` or by path), Go (`go vet ./...`, `go build ./...`, `go test ./...`), Rust (`cargo check`, `cargo clippy`, `cargo build`, `cargo test`). Same rules apply.

## Prove it

Run `SHIP run-checks` on the untouched base commit before locking. Then:
- A command that's wrong (missing script, wrong path): fix checks.json.
- A check that genuinely fails on the base (pre-existing type or lint errors, a red test): keep the check, and make restoring it to green the first task, as its own commit. If the baseline is badly broken (roughly more than 30 errors), scope that check to the changed files with `{files}` instead, and record that decision with `SHIP log` and in the spec's Decisions section.
- Too slow (minutes per run): prefer a faster faithful variant and record why.

Then `SHIP lock-checks`. From then on the gate compares checks.json against the locked copy.

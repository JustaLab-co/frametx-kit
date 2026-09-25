## What this changes

<!-- One or two sentences. The PR title carries the conventional-commit prefix; this is the prose version. -->

## Why

<!-- The reasoning goes here, not in a code comment. If this fixes an issue, link it: Closes #N -->

## How the new behaviour is pinned

Which oracle covers this change, and why it could actually fail:

- [ ] A published figure, transcribed rather than derived
- [ ] The golden byte vector or sig-hash from ethrex's `frame_tx_wire_tests.rs`
- [ ] Re-encoding captured chain data and reproducing the transaction hash
- [ ] A live receipt (recovered signer, `maxCost`, or the `gasUsed` decomposition)
- [ ] N/A, this change has no wire-format or gas behaviour

<!-- A test that asserts the code's own output against itself does not count. See CONTRIBUTING.md, "Tests". -->

## Load-bearing rules

Did this touch anything under "Rules that are not style preferences" in `CONTRIBUTING.md`, such as a derived gas constant, a golden vector, a captured fixture, the module import order, or `encodeFrameTx` validating?

- [ ] No
- [ ] Yes, and the argument for it is below

## Checks

Only tick what you ran.

- [ ] `bun run test`
- [ ] `bun run typecheck`
- [ ] `bun run build && bunx @arethetypeswrong/cli --pack .` (required if `exports`, `files`, `typesVersions` or `tsup.config.ts` changed; otherwise N/A)
- [ ] `bun run test:live` (optional, hits the public endpoint, not a gate)

## Release impact

The commit history sets the version, so say which this is:

- [ ] No release (`docs`, `chore`, `test`, `ci`, `refactor`, `style`, `perf`, `build`)
- [ ] Patch (`fix`)
- [ ] Minor (`feat`)
- [ ] Major (`feat!` or a `BREAKING CHANGE:` footer)

A wire-format or gas change is almost always at least a `fix:`, because someone downstream is encoding bytes with this.

## AI assistance

- [ ] This change was written or reviewed with an assistant, and I have read every line of it

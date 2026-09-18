# Security policy

## Reporting

Report privately through [GitHub's advisory form](https://github.com/JustaLab-co/frametx-kit/security/advisories/new). Do not open a public issue for anything listed as in scope below.

Include the transaction hash, the raw bytes, or the smallest snippet that shows the problem, plus the library version and the ethrex commit or endpoint you were talking to. The reports that get fixed fastest are the ones that come with bytes.

You will get an acknowledgement within three working days. If a fix is warranted we will agree a disclosure date with you before publishing, and credit you in the advisory and the changelog unless you would rather not be named.

## Scope

hegota-testnet is a testnet and the assets on it are not real. The interesting risk here is not the coins, it is that this library produces bytes a signer is asked to authorise, and that consumers will carry the same code onto a chain where the assets are real. Treat the following as in scope:

- A signature or sig-hash flaw that lets a transaction be authorised for something other than what it appears to say, including the `v || r || s` byte order, the recovery id encoding, and signer resolution.
- An encoder or decoder flaw where the bytes on the wire do not match the transaction the caller handed in, or where `getFrameTransaction` returns something whose re-encoding does not reproduce its hash.
- `assertValidFrameTx` accepting an envelope that consensus rejects, or accepting a signature it should refuse.
- Gas accounting that understates `maxCost`, so a caller budgets less than the chain will charge.
- Any path where node-supplied data reaches a caller as trusted, without the hash check that is meant to pin it.
- A dependency in the published tarball that runs code at install time or reaches the network.

Out of scope, and better reported elsewhere:

- Bugs in the ethrex node, which belong in [its issue tracker](https://github.com/lambdaclass/ethrex/issues). Open a divergence report here as well so the disagreement is recorded.
- The availability or the data served by the public endpoint at `rpc1.privacy.ethrex.xyz`, which this project does not operate.
- Anything that requires a caller to pass their own private key to code they chose to run.
- A missing validation in `encodeFrameTx`, which does not validate by design. The strict path is `assertValidFrameTx(tx)` and then `encodeFrameTx(tx)`, and the reasoning is in `CONTRIBUTING.md`.

## Supported versions

Pre-1.0, only the latest published version receives fixes. Upgrade before reporting, and say which version you tested.

Releases are published to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements) from the tagged commit in this repository, so you can verify that a tarball was built from the source you are reading.

## Dependencies

Installs are held to a seven day minimum release age, transitive dependencies included, so a hijacked release is likely to be found before it reaches anyone's `node_modules`. The value lives in `bunfig.toml` and applies to contributors and to CI. It does nothing against a package that was malicious from its first version, so a new dependency still gets its repository and its install scripts read before it is added.

# frametx-kit

[![npm](https://img.shields.io/npm/v/%40jaw.id%2Fframetx-kit)](https://www.npmjs.com/package/@jaw.id/frametx-kit)
[![CI](https://github.com/JustaLab-co/frametx-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/JustaLab-co/frametx-kit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/JustaLab-co/frametx-kit/badge)](https://scorecard.dev/viewer/?uri=github.com/JustaLab-co/frametx-kit)

TypeScript for the current **EIP-8141 frame transaction** envelope implemented by
the Ethrex frames devnet (chain ID `81410`).

Decode, build, hash, sign, price, dry-run and broadcast.

## Install

```bash
bun add @jaw.id/frametx-kit viem
```

`viem` is a peer dependency, not a bundled one. `frameActions` extends a viem client, so
your client and this library have to be the same viem.

## Use

```ts
import { createPublicClient, http } from 'viem'
import { frameActions } from '@jaw.id/frametx-kit/viem'

const client = createPublicClient({
  transport: http('https://rpc1.frames.ethrex.xyz'),
}).extend(frameActions)

const tx = await client.getFrameTransaction({ hash })
const receipt = await client.getFrameTransactionReceipt({ hash })
```

Building a transaction? Call `assertValidFrameTx(tx)` before `encodeFrameTx(tx)`. The
encoder itself does not validate, because `sig_hash` is defined over a re-encoding and a
validating encoder would reject the live chain data this library is meant to survey.

```ts
import { assertValidFrameTx, encodeFrameTx, signFrameTx } from '@jaw.id/frametx-kit'

const signed = await signFrameTx(tx, privateKey)
assertValidFrameTx(signed)
const raw = encodeFrameTx(signed)
```

`signFrameTx` also takes a `FrameSigner` instead of a key — anything with an `address` and a
raw-digest `sign`, which covers viem's `privateKeyToAccount` and `mnemonicToAccount`, a
`toAccount` source, and your own wrapper around a hardware wallet, an HSM or a remote
signer. It signs every SECP256K1 entry whose `msg` is empty, and refuses if the entry's
resolved signer is not that account's address.

```ts
import { privateKeyToAccount } from 'viem/accounts'

const signed = await signFrameTx(tx, privateKeyToAccount(privateKey))

// a remote signer needs nothing else:
const signed = await signFrameTx(tx, {
  address: '0x…',
  sign: ({ hash }) => myKms.signDigest(hash), // r||s||v, v as 27/28 or a bare 0/1
})
```

A raw-digest `sign` is required. `signMessage` will not do: it EIP-191-prefixes its
argument, so the signature recovers to nothing. A `JsonRpcAccount` (a browser wallet)
cannot sign a raw digest at all — both are refused with an error rather than producing a
transaction the chain silently rejects.

P256 and ARBITRARY entries are left untouched; build those signatures yourself and let
`assertValidFrameTx` check them. `signFrameTx` also handles one signer at a time, so a
transaction with entries for two different signers needs the bytes assembled by hand.

Sending walks the strict path for you — `assertValidFrameTx`, `encodeFrameTx`,
`eth_sendRawTransaction` — and checks that the hash the node returns is `keccak256` of the
bytes it was given. The receipt wait is frame-aware: a skipped frame comes back as
`'skipped'`, not as a revert.

```ts
const hash = await client.sendFrameTransaction({ transaction: signed })
const receipt = await client.waitForFrameTransactionReceipt({ hash })
```

Passing every check here does not guarantee admission. On this chain the VERIFY prefix must
call `APPROVE`, which a plain EOA sender cannot do, so a broadcastable transaction needs a
sender contract and a funded key — both are yours, not this library's. Dry-run with
`client.simulateFrameTransaction({ raw })` before spending.

## Two things that will bite you

**Frame receipt status is three-valued** — `'failure'`, `'success'`, `'skipped'`. A
skipped frame never executed and its gas was refunded. It is not a revert.

**The chain's public RPC serves no raw transaction bytes.** `getFrameTransaction` reads
the node's decoded JSON, re-encodes it, and refuses to return anything whose re-encoding
does not reproduce the transaction hash. What you get back is a transaction this library
can put back on the wire byte-for-byte.

## Gas

`frameTxGas` prices the current EIP-8141 transaction shape. The historical
`'chain'`, `'pins'`, and `'head'` rule-set names remain accepted as compatibility
aliases and currently produce identical results.

```ts
import { compareRuleSets, decodeFrameTx } from '@jaw.id/frametx-kit'
console.log(compareRuleSets(decodeFrameTx(raw), 'chain', 'pins'))
```

Every gas constant is written as its published figure rather than derived. ethrex's own
suite missed its intrinsic dropping from 15000 to 12000 across 1372 tests by deriving the
expected value from the constant under test.

## Tests

```bash
bun run test        # hermetic, no network
bun run typecheck
```

The default suite is hermetic. Its golden RLP and signature hash are pinned to the
current Ethrex `FrameTransaction` encoder.

## Contributing

Contributions welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — this wire format
has traps, and several things in `src/` that look like code smells are load-bearing.

The most valuable report is a disagreement with the reference client. If this library and
ethrex produce different bytes, a different hash, a different price or a different receipt,
open a [divergence report](https://github.com/JustaLab-co/frametx-kit/issues/new?template=01-divergence.yml)
with the transaction hash or the byte vector. That is what a second implementation is for.

Anything that could let a transaction be authorised for something other than what it says
goes to [`SECURITY.md`](SECURITY.md) and a private advisory instead of a public issue.

Looking for somewhere to start? The issues labelled
[good first issue](https://github.com/JustaLab-co/frametx-kit/issues?q=is%3Aopen+label%3A%22good+first+issue%22)
are the coverage gaps that need a captured transaction rather than a design decision.

## Docs

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — architecture, invariants, wire-format traps, how
  the verification oracles work
- [`docs/DESIGN.md`](docs/DESIGN.md) — the binding design spec
- [`docs/OPEN-ITEMS.md`](docs/OPEN-ITEMS.md) — known gaps and unfinished work
- [`SECURITY.md`](SECURITY.md) — what counts as a vulnerability here, and how to report it
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — expected conduct in issues and pull requests

## License

MIT

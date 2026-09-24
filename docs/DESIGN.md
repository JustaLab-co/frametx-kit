# frametx-kit design

The binding spec for what the library does. Where the code and this document disagree,
one of them has a bug; say which.

**Target:** the EIP-8141 frame transaction with EIP-8250 keyed nonces, as served by the
Ethrex hegota-testnet — chain ID `8141`, `https://rpc1.privacy.ethrex.xyz`, Ethrex
`v23.0.0-hegota-testnet-bdfc5d8f2e7f653e620a9901db915f89a87a3d0d`. Citations of
`transaction.rs`, `frame_tx_wire_tests.rs` and other `.rs` / `.py` paths refer to that
commit of [`lambdaclass/ethrex`](https://github.com/lambdaclass/ethrex/tree/bdfc5d8f2e7f653e620a9901db915f89a87a3d0d).

## 1. Scope

A TypeScript client for frame transactions: build, validate, encode, decode, hash, sign,
price, simulate, broadcast, and read them back with their frame receipts. It ships a small
account abstraction (`toFrameAccount`, `toEoaFrameAccount`), `prepareFrameTransaction`,
and a viem extension (`client.extend(frameActions)`). It is not a fork of viem core.

Not supported:

- **Recent-root verifier frames** (EIP-8272). The chain carries recent-root references in a
  VERIFY frame targeting `0x…8272`; the library does not build that frame. A transaction
  that contains one still decodes, encodes and prices as ordinary frames.
- **Blob sidecars.** `blobVersionedHashes` is carried through the envelope, but a
  blob-carrying transaction must be broadcast in the EIP-7594 wrapper, which the library
  does not produce.
- **UTXO frames** (mode 5, EIP-8312), inert on this chain.
- **P256 and ARBITRARY signing.** Both are validated, neither is produced by `signFrameTx`.

## 2. The envelope

```text
raw       = 0x06 || rlp([chain_id, nonce_keys, nonce_seq, sender, frames, signatures,
                         fees, blob_versioned_hashes])
fees      = [max_priority_fee_per_gas, max_fee_per_gas, max_fee_per_blob_gas]
frame     = [mode, flags, target, limits, value, data]
limits    = [execution, state]
signature = [scheme, signer, msg, signature]
```

Integers are canonical minimal big-endian RLP: zero is the empty string, never `0x00`.
`limits` is always two elements and `fees` always three, zeros included. An empty
`target` means `tx.sender`; an empty `signer` is resolved per §3.

Field widths are those ethrex decodes at: `chain_id` and `nonce_seq` are uint64; the nonce
keys, all three fees and `value` are uint256; addresses are exactly 20 bytes. A wider value
would encode to well-formed RLP that the node cannot decode.

**Nonces (EIP-8250).** `nonce_keys` holds 1 to 16 strictly increasing keys; `nonce_seq`
must be below `2**64 - 1` and equal the current sequence of every selected key. Key `0` is
the sender's account nonce and is valid only as the sole key. Any other key is a slot of
the `NONCE_MANAGER` predeploy at `0x0000000000000000000000000000000000008250`:

```text
slot(sender, key) = keccak256(left_pad_32(sender) || uint256_be(key))
```

An unused key reads zero. There is no RPC for keyed nonces; they are read with
`eth_getStorageAt`.

**Frames.** Modes are 0 DEFAULT, 1 VERIFY, 2 SENDER. `flags` bits 0-1 are the APPROVE scope
(payment `0x1`, execution `0x2`), bit 2 marks an atomic batch, bits 3-7 are reserved and
must be zero.

**Structural rules** (`validateFrameTx`, transcribed from `validate_static_constraints`,
`transaction.rs:2667`, checked in the same order): sender non-zero; the nonce rules above;
1 to 64 frames; at most 6 blob hashes, each 32 bytes with the `0x01` KZG version byte, and
`max_fee_per_blob_gas` zero without blobs; signature entries well-formed (§3); only SENDER
frames carry value; `APPROVE_EXECUTION` only with an empty target or `tx.sender`; per-frame
and cumulative limits within `2**63 - 1`; at most one expiry frame (VERIFY to `0x…8141`,
flags 0, 8-byte data, `limits.state` 0); atomic batches never on a VERIFY frame or the
last frame, never followed by a VERIFY frame, and no frame in a batch approving a scope.
Rules that need chain state — nonce values, balances, the validation prefix — are the
node's, and `simulateFrameTransaction` replays them.

## 3. Signatures

**Signature hash.** `keccak256(0x06 || rlp(body))` with the `signature` bytes of every entry
whose `msg` is empty replaced by `0x`. Every other field, frames included, is committed as
encoded. An entry with an explicit 32-byte, non-zero `msg` signs that digest instead and
its bytes stay in the hash.

**Schemes.**

| Scheme | Layout | Canonical form |
|---|---|---|
| 0 ARBITRARY | any bytes | `signer` must be empty |
| 1 SECP256K1 | `v \|\| r \|\| s`, 65 bytes | `v` a bare recovery id `0` or `1`, `0 < r < n`, `0 < s <= n/2` |
| 2 P256 | `r \|\| s \|\| qx \|\| qy`, 128 bytes | `0 < r < n`, `0 < s <= n/2` |

The SECP256K1 layout is the reverse of Ethereum's usual `r || s || v`, and a 27/28 `v`
invalidates the transaction at consensus. `signFrameTx` normalizes whatever a signer
returns into this form.

**Signer resolution.** An empty `signer` resolves to `tx.sender` for SECP256K1 and P256.
`signFrameTx` signs every empty-`msg` SECP256K1 entry whose resolved signer is the signing
account, and refuses a signer that cannot sign a raw digest (EIP-191 `signMessage`, JSON-RPC
accounts) rather than produce a signature that recovers to nothing.

## 4. Gas

EIP-8141 constants, written as published figures in `gas.ts` and never derived:

| Constant | Value |
|---|---|
| `FRAME_TX_INTRINSIC_COST` | 12,000 |
| `FRAME_TX_PER_FRAME_COST` | 475 |
| `FRAME_TX_VALUE_COST` | 6,000 |
| Signature verification | ARBITRARY 100, SECP256K1 2,800, P256 6,700 |
| `STANDARD_TOKEN_COST` / `TOTAL_COST_FLOOR_PER_TOKEN` | 4 / 16 |
| `GAS_PER_BLOB` | 131,072 |

```text
mandatory     = 12000 + 475 * len(frames) + Σ signature cost
                + 6000 per frame moving value to an explicit target other than the sender
billed bytes  = each frame's data, each signature's signer, msg and signature,
                and nonce_calldata = rlp(nonce_keys) || rlp(nonce_seq)
data cost     = 4 per zero byte + 16 per non-zero byte, over the billed bytes
intrinsic     = mandatory + data cost
standard      = intrinsic + Σ limits.execution + Σ limits.state
floor total   = mandatory + 16 * 4 * len(billed bytes)
max_gas       = max(standard, floor total + Σ limits.state)
max_cost      = max_gas * max_fee_per_gas + len(blobs) * 131072 * blob_base_fee
```

State gas is added on top of the calldata floor, never absorbed by it. The same holds for
what a receipt reports:
`gasUsed = max(intrinsic + Σ frame gasUsed, floor total) + Σ frame stateGasUsed`, less any
storage refund, which frame receipts do not itemize.

**Nonce state gas.** Consuming a nonce charges state gas at execution time against the
payment-approving frame's `limits.state`: `KEYED_NONCE_FIRST_USE_STATE_GAS` (97,920) for each
non-zero key whose slot is still zero, and `NEW_ACCOUNT_STATE_GAS` (183,600) for key `[0]`
from a sender that does not exist yet. These are budgeting figures for choosing
`limits.state`, not terms of `frameTxGas`.

## 5. Accounts and preparation

A `FrameAccountImplementation` supplies `getAddress()`, `getNonce({ key?, blockTag? })` (the
current sequence of one nonce key), `getValidationData({ calls, chainId, nonceKeys,
nonceSeq })`, `signFrameTransaction(tx)` and an execution strategy; `toFrameAccount`
resolves it into a `FrameAccount`.

`toEoaFrameAccount` targets a code-less EOA through the protocol's default code: key `0`
from `eth_getTransactionCount`, other keys from `NONCE_MANAGER` via `eth_getStorageAt`, empty
validation data, and one empty-`msg`, empty-`signer` SECP256K1 entry.

`prepareFrameTransaction(account, calls, limits, { nonceKeys?, blockTag? })` builds one
VERIFY frame with scope `0x3` followed by one SENDER frame per call, reads fees from the node
(`2 * baseFee + priorityFee`, or `eth_gasPrice` without a base fee), and defaults to
`nonceKeys: [0n]` at `blockTag: 'pending'`. Selected keys must currently sit at the same
sequence, since one `nonceSeq` is matched against all of them. The caller supplies every
frame's limits.

## 6. RPC surface

**Transactions.** `eth_getTransactionByHash` returns `type` (`'0x6'`), `chainId`,
`nonceKeys` (a list of quantities), `nonceSeq`, `sender`, `frames` (`mode`, `flags`, `to`,
`gasLimit`, `stateGasLimit`, `value`, `data`), `signatures`, the three fees and
`blobVersionedHashes`. The frame target is `to`, not `target`.

The node serves no raw bytes: there is no `eth_getRawTransactionByHash`, and the public
endpoint refuses `debug_getRawTransaction`. `getFrameTransaction` therefore re-encodes the
JSON and refuses a result whose re-encoding does not hash to the transaction hash, which
is `keccak256` of exactly the canonical bytes.

**Receipts.** `eth_getTransactionReceipt` adds `payer` and `frameReceipts[]` with `status`,
`gasUsed`, `stateGasUsed` and `logs`. Frame status is three-valued — `0` failure, `1`
success, `2` skipped — and a skipped frame never executed; it is not a revert.

**Broadcast.** `eth_sendRawTransaction` takes `0x06 || rlp(body)`; the returned hash is
checked against `keccak256` of the bytes sent, and the request is not retried, so an
accepted broadcast is never re-posted. Admission needs a VERIFY prefix that approves
payment from a payer holding `max_cost`.

**Simulation.** `ethrex_simulateFrameTransaction(raw, 'latest')` returns `valid`,
`prefixShape` (`SelfVerify`, `DeploySelfVerify`, `OnlyVerifyPay`, `DeployOnlyVerifyPay`),
`payer`, `maxCost`, `violation`, `gasUsed`, `frames[]` (`gasUsed`, `succeeded`),
`executionStatus` and `executionError`. Each field is checked, not cast. `maxCost` is
reported even on structural rejection. `valid: true` is necessary but not sufficient for
admission, and only `latest` works: historical state is pruned.

## 7. Errors and strictness

Every error is a typed class with a stable `name`, following viem's conventions:
`FrameEncodeError`, `FrameDecodeError` and `FrameRlpError`.

**Encode is not validation.** `encodeFrameTx` encodes whatever it is given, because
`frameTxSigHash` is defined over a re-encoding. The strict path is `assertValidFrameTx(tx)`
(the §2 rules plus §3 canonicality) and then `encodeFrameTx(tx)`;
`frameActions(client).sendFrameTransaction` walks it for you.

**Decode is lenient about shapes, strict about bytes.** `decodeFrameTx` accepts any
structure the chain accepted, but walks the body with `walkRlp` rather than viem's
`fromRlp`, so it rejects what ethrex rejects at RLP decode: a long-form single-byte scalar,
a non-minimal length or leading zero, a non-byte-aligned string, nesting deeper than 1024.
Malformed RLP produces a typed error carrying the byte offset at which parsing failed,
counting the `0x06` type byte as byte 0. A re-encoding is also compared against the input
as a backstop. Strict decode is `decodeFrameTx(raw)` followed by `assertValidFrameTx(tx)`.

## 8. Modules

| Module | Responsibility | Depends on |
|---|---|---|
| `types`, `errors` | The transaction shape; typed errors | — |
| `chain` | `hegotaTestnet`, a viem chain definition | viem |
| `rlp` | Minimal scalars, `walkRlp` | `errors` |
| `envelope` | `encodeFrameTx`, `decodeFrameTx`, `validateFrameTx` | `rlp`, `errors`, `types` |
| `sighash` | `frameTxSigHash` | `envelope` |
| `signatures` | Canonicality, recovery, signer resolution, `signFrameTx`, `assertValidFrameTx` | `sighash`, `envelope` |
| `gas` | `frameTxGas`, `frameTxMaxCost`, `nonceCalldata` | `rlp`, `types` |
| `nonce` | `NONCE_MANAGER`, `keyedNonceSlot`, `getFrameNonceSeq` | `errors` |
| `rpc` | Transaction and receipt parsing, simulate, broadcast | `errors`, `types` |
| `accounts`, `prepareFrameTransaction`, `signFrameTransaction` | Frame accounts and transaction preparation | `envelope`, `signatures`, `nonce` |
| `viem` | `frameActions`, no wire logic of its own | `envelope`, `signatures`, `rpc`, `gas` |

Nothing imports upward. `gas` does not import `envelope`, so the gas model stays
independently testable; `envelope` does not import `signatures`.

## 9. Testing

The default suite is hermetic. It pins the golden vector and sig-hash transcribed from
`frame_tx_wire_tests.rs:69-70`, the published gas figures, and a set of captured chain
transactions checked end to end (hash, signer, `maxCost`, receipt gas). The `test:live`
suite, gated on `FRAMES_LIVE=1`, is read-only. Broadcasting is checked manually with
`scripts/send-eth-eoa.ts`. `CONTRIBUTING.md` covers running, refreshing and extending the
tests.

import { describe, expect, test } from 'vitest'
import { createClient, custom, getAddress, size, sliceHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import * as P256 from 'ox/P256'
import { toFrameAccount } from '../src/accounts/toFrameAccount.js'
import { toFramePayerAccount } from '../src/accounts/toFramePayerAccount.js'
import { privateKeyToP256Account } from '../src/p256.js'
import { frameTxSigHash } from '../src/sighash.js'
import { recoverFrameSigner, signFrameSignature } from '../src/signatures.js'
import type { FrameTransaction } from '../src/types.js'
import { GOLDEN_TX } from './fixtures/golden.js'

const OWNER_KEY = `0x${'11'.repeat(32)}` as const
const OTHER = getAddress('0x0000000000000000000000000000000000009999')
const DELEGATE = getAddress('0x0000000000000000000000000000000000005678')

describe('toFrameAccount', () => {
  test('resolves methods and extensions', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() { throw new Error('unexpected RPC request') } }),
    })
    const address = getAddress('0x0000000000000000000000000000000000001234')
    const account = await toFrameAccount({
      client,
      owner,
      execution: { type: 'direct' },
      extend: { implementationName: 'test-account' as const },
      async getAddress() { return address },
      async getNonce() { return 1n },
      async getValidationData({ nonceSeq }) { return nonceSeq === 1n ? '0xabcd' : '0x' },
      async getSignatureEntries() { return [] },
      async signFrameTransaction(transaction) { return transaction },
    })

    expect(account.address).toBe(address)
    expect(account.type).toBe('frame')
    expect(account.implementationName).toBe('test-account')
    expect(await account.getNonce()).toBe(1n)
    expect(
      await account.getValidationData({ calls: [], chainId: 1n, nonceKeys: [0n], nonceSeq: 1n }),
    ).toBe('0xabcd')
    expect(await account.signFrameTransaction(GOLDEN_TX as FrameTransaction)).toBe(GOLDEN_TX)
  })

  test('resolved fields override extension properties', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({
      client,
      owner,
      execution: { type: 'direct' },
      extend: { address: 'extension-value', type: 'extension-value' },
      getAddress: async () => owner.address,
      getNonce: async () => 0n,
      getValidationData: async () => '0x',
      getSignatureEntries: async () => [],
      signFrameTransaction: async (transaction) => transaction,
    })

    expect(account.address).toBe(owner.address)
    expect(account.type).toBe('frame')
  })

  test('resolves a custom address once and reuses it in every default', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    let resolutions = 0
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() { return '0x0' } }),
    })
    const account = await toFrameAccount({
      client,
      owner,
      getAddress: async () => {
        resolutions++
        return owner.address
      },
    })

    await account.getNonce()
    await account.getSignatureEntries(GOLDEN_TX)
    await account.signFrameTransaction({
      ...GOLDEN_TX,
      sender: owner.address,
      signatures: [],
    })
    expect(resolutions).toBe(1)
  })

  test('rejects address together with getAddress', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() {} }),
    })

    await expect(
      toFrameAccount({
        client,
        owner,
        address: owner.address,
        getAddress: async () => OTHER,
      }),
    ).rejects.toThrow(/both address and getAddress/)
  })

  test('supports an ownerless account when every policy callback is supplied', async () => {
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({
      client,
      address: OTHER,
      getNonce: async () => 3n,
      getValidationData: async () => '0xabcd',
      getSignatureEntries: async () => [],
      signFrameTransaction: async (transaction) => transaction,
    })

    expect(account.owner).toBeUndefined()
    expect(account.address).toBe(OTHER)
    expect(await account.getNonce()).toBe(3n)
  })
})

describe('toFramePayerAccount defaults', () => {
  test('uses default-code payment approval and signs index 1 as the payer', async () => {
    const sender = privateKeyToAccount(OWNER_KEY)
    const payerOwner = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const payer = await toFramePayerAccount({ owner: payerOwner })
    const transaction = {
      ...GOLDEN_TX,
      sender: sender.address,
      frames: [
        {
          ...GOLDEN_TX.frames[0]!,
          flags: 0x1,
          target: payerOwner.address,
        },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [
        { scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const },
      ],
    }

    expect(payer.address).toBe(payerOwner.address)
    expect(payer.type).toBe('framePayer')
    expect(await payer.getPayData(transaction)).toBe('0x')

    const entries = await payer.getSignatureEntries(transaction)
    expect(entries).toEqual([
      { scheme: 1, signer: payerOwner.address, msg: '0x', signature: '0x' },
    ])

    const signed = await payer.signFrameTransaction({
      ...transaction,
      signatures: [...transaction.signatures, ...entries],
    })
    expect(await recoverFrameSigner(signed, 1)).toBe(payerOwner.address)
  })

  test('does not hardcode the payer signature index', async () => {
    const payer = await toFramePayerAccount({
      owner: privateKeyToAccount(`0x${'22'.repeat(32)}`),
    })
    const transaction = {
      ...GOLDEN_TX,
      frames: [
        {
          ...GOLDEN_TX.frames[0]!,
          flags: 0x1,
          target: payer.address,
        },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [],
    }

    const signed = await payer.signFrameTransaction(transaction)

    expect(signed.signatures).toHaveLength(1)
    expect(await recoverFrameSigner(signed, 0)).toBe(payer.owner.address)
  })

  test('does not append its entry after another entry has been signed', async () => {
    const sender = privateKeyToAccount(OWNER_KEY)
    const payer = await toFramePayerAccount({
      owner: privateKeyToAccount(`0x${'22'.repeat(32)}`),
    })
    const unsigned = {
      ...GOLDEN_TX,
      sender: sender.address,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x1, target: payer.address },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [
        { scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const },
      ],
    }
    const senderSigned = await signFrameSignature(unsigned, 0, sender)

    await expect(payer.signFrameTransaction(senderSigned)).rejects.toThrow(
      /other entries are already signed/,
    )
    expect(await recoverFrameSigner(senderSigned, 0)).toBe(sender.address)
  })

  test('refuses the default payer policy when sender and payer are the same address', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const payer = await toFramePayerAccount({ owner })
    const transaction = {
      ...GOLDEN_TX,
      sender: owner.address,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x1, target: owner.address },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [
        { scheme: 1 as const, signer: null, msg: '0x' as const, signature: '0x' as const },
      ],
    }

    await expect(payer.getSignatureEntries(transaction)).rejects.toThrow(
      /cannot also be the transaction sender/,
    )
    await expect(payer.signFrameTransaction(transaction)).rejects.toThrow(
      /cannot also be the transaction sender/,
    )
  })

  test('refuses to sign without a pay frame targeting the payer', async () => {
    const payer = await toFramePayerAccount({
      owner: privateKeyToAccount(`0x${'22'.repeat(32)}`),
    })

    await expect(
      payer.signFrameTransaction({ ...GOLDEN_TX, signatures: [] }),
    ).rejects.toThrow(/no payment-only VERIFY frame/)
  })

  test('refuses a payer-targeted VERIFY frame with non-payment approval flags', async () => {
    const payer = await toFramePayerAccount({
      owner: privateKeyToAccount(`0x${'22'.repeat(32)}`),
    })
    const transaction = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x3, target: payer.address },
        ...GOLDEN_TX.frames.slice(1),
      ],
    }

    await expect(payer.getSignatureEntries(transaction)).rejects.toThrow(
      /no payment-only VERIFY frame/,
    )
  })

  test('refuses a payer-targeted non-VERIFY frame', async () => {
    const payer = await toFramePayerAccount({
      owner: privateKeyToAccount(`0x${'22'.repeat(32)}`),
    })
    const transaction = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, mode: 2 as const, flags: 0x1, target: payer.address },
        ...GOLDEN_TX.frames.slice(1),
      ],
    }

    await expect(payer.getSignatureEntries(transaction)).rejects.toThrow(
      /no payment-only VERIFY frame/,
    )
  })

  test('signs through a raw-digest override for an injected payer account', async () => {
    const signer = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const owner = { address: signer.address, type: 'json-rpc' as const }
    const payer = await toFramePayerAccount({
      owner,
      sign: ({ hash }) => signer.sign({ hash }),
    })
    const transaction = {
      ...GOLDEN_TX,
      frames: [
        {
          ...GOLDEN_TX.frames[0]!,
          flags: 0x1,
          target: payer.address,
        },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [
        { ...GOLDEN_TX.signatures[0]!, signature: '0x' as const },
        { scheme: 1 as const, signer: owner.address, msg: '0x' as const, signature: '0x' as const },
      ],
    }

    const signed = await payer.signFrameTransaction(transaction)

    expect(await recoverFrameSigner(signed, 1)).toBe(owner.address)
  })
})

describe('toFramePayerAccount', () => {
  test('resolves methods and extensions', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const address = getAddress('0x0000000000000000000000000000000000009999')
    const payer = await toFramePayerAccount({
      owner,
      extend: { implementationName: 'test-payer' as const },
      getAddress: async () => address,
      getPayData: async (_transaction: FrameTransaction) => '0xabcd',
      getSignatureEntries: async () => [],
      signFrameTransaction: async (transaction) => transaction,
    })

    expect(payer.address).toBe(address)
    expect(payer.type).toBe('framePayer')
    expect(payer.implementationName).toBe('test-payer')
    expect(await payer.getPayData(GOLDEN_TX)).toBe('0xabcd')
  })

  test('uses the default P-256 payer entry and signing policy', async () => {
    const owner = privateKeyToP256Account(`0x${'01'.padStart(64, '0')}`)
    const payerAddress = getAddress('0x0000000000000000000000000000000000009999')
    const payer = await toFramePayerAccount({ owner, address: payerAddress })
    const transaction = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x1, target: payerAddress },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [],
    }

    const signed = await payer.signFrameTransaction(transaction)
    const entry = signed.signatures[0]!
    const signature = {
      r: BigInt(sliceHex(entry.signature, 0, 32)),
      s: BigInt(sliceHex(entry.signature, 32, 64)),
    }
    const publicKey = {
      prefix: 4 as const,
      x: BigInt(sliceHex(owner.publicKey, 1, 33)),
      y: BigInt(sliceHex(owner.publicKey, 33, 65)),
    }

    expect(payer.owner).toBe(owner)
    expect(entry).toMatchObject({ scheme: 2, signer: owner.address, msg: '0x' })
    expect(size(entry.signature)).toBe(128)
    expect(
      P256.verify({ payload: frameTxSigHash(signed), publicKey, signature }),
    ).toBe(true)
  })

  test('supports an ownerless payer when every policy callback is supplied', async () => {
    const payer = await toFramePayerAccount({
      address: OTHER,
      getPayData: async () => '0xabcd',
      getSignatureEntries: async () => [],
      signFrameTransaction: async (transaction) => transaction,
    })

    expect(payer.owner).toBeUndefined()
    expect(payer.address).toBe(OTHER)
    expect(await payer.getPayData(GOLDEN_TX)).toBe('0xabcd')
  })

  test('uses the resolved payer address for pay-frame checks', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const payer = await toFramePayerAccount({ owner, address: OTHER })
    const targeted = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x1, target: OTHER },
        ...GOLDEN_TX.frames.slice(1),
      ],
    }
    expect(await payer.getSignatureEntries(targeted)).toHaveLength(1)

    await expect(
      payer.getSignatureEntries({
        ...targeted,
        frames: [
          { ...targeted.frames[0]!, target: owner.address },
          ...targeted.frames.slice(1),
        ],
      }),
    ).rejects.toThrow(/no payment-only VERIFY frame/)
  })

  test('resolves a custom payer address once and reuses it in every default', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    let resolutions = 0
    const payer = await toFramePayerAccount({
      owner,
      getAddress: async () => {
        resolutions++
        return OTHER
      },
    })
    const transaction = {
      ...GOLDEN_TX,
      frames: [
        { ...GOLDEN_TX.frames[0]!, flags: 0x1, target: OTHER },
        ...GOLDEN_TX.frames.slice(1),
      ],
      signatures: [
        { scheme: 1 as const, signer: owner.address, msg: '0x' as const, signature: '0x' as const },
      ],
    }

    await payer.getSignatureEntries(transaction)
    await payer.signFrameTransaction(transaction)
    expect(resolutions).toBe(1)
  })

  test('rejects address together with getAddress', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)

    await expect(
      toFramePayerAccount({
        owner,
        address: owner.address,
        getAddress: async () => OTHER,
      }),
    ).rejects.toThrow(/both address and getAddress/)
  })
})

describe('toFrameAccount defaults', () => {
  test('uses default-code validation and signs as the EOA', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({ client, owner })
    const unsigned = { ...GOLDEN_TX, sender: owner.address, signatures: [] }

    expect(
      await account.getValidationData({ calls: [], chainId: 1n, nonceKeys: [0n], nonceSeq: 0n }),
    ).toBe('0x')
    const signed = await account.signFrameTransaction(unsigned)
    expect(signed.signatures[0]).toMatchObject({ scheme: 1, signer: null, msg: '0x' })
    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
  })

  test('signs through a raw-digest override for an injected account', async () => {
    const signer = privateKeyToAccount(OWNER_KEY)
    const owner = { address: signer.address, type: 'json-rpc' as const }
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({
      client,
      owner,
      sign: ({ hash }) => signer.sign({ hash }),
    })
    const transaction = {
      ...GOLDEN_TX,
      sender: owner.address,
      signatures: [],
    }

    const signed = await account.signFrameTransaction(transaction)

    expect(await recoverFrameSigner(signed, 0)).toBe(owner.address)
  })

  test('rejects a raw signer that signs with a different secp256k1 key', async () => {
    const owner = { address: privateKeyToAccount(OWNER_KEY).address, type: 'json-rpc' as const }
    const wrongSigner = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({
      client,
      owner,
      sign: ({ hash }) => wrongSigner.sign({ hash }),
    })

    await expect(
      account.signFrameTransaction({
        ...GOLDEN_TX,
        sender: owner.address,
        signatures: [],
      }),
    ).rejects.toThrow(/expected owner/)
  })

  test('uses explicit signer metadata for delegated and distinct-address owners', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const delegationCode = `0xef0100${DELEGATE.slice(2)}`
    const requests: { method: string; params?: unknown }[] = []
    const delegatedClient = createClient({
      chain: mainnet,
      transport: custom({
        async request(request) {
          requests.push(request)
          const { method } = request
          if (method === 'eth_getCode') return delegationCode
          throw new Error(`unexpected ${method}`)
        },
      }),
    })
    const delegated = await toFrameAccount({
      client: delegatedClient,
      owner,
      address: owner.address,
      delegateAddress: DELEGATE,
    })
    const distinct = await toFrameAccount({
      client: createClient({ chain: mainnet, transport: custom({ async request() {} }) }),
      owner,
      address: OTHER,
    })

    expect((await delegated.getSignatureEntries(GOLDEN_TX))[0]!.signer).toBe(owner.address)
    expect((await distinct.getSignatureEntries(GOLDEN_TX))[0]!.signer).toBe(owner.address)
    expect(requests).toEqual([
      { method: 'eth_getCode', params: [owner.address, 'latest'] },
    ])
  })

  test('verifies the expected EIP-7702 delegate against account code', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() { return '0x' } }),
    })

    await expect(
      toFrameAccount({ client, owner, delegateAddress: DELEGATE }),
    ).rejects.toThrow(/expected 0xef0100/)
  })

  test('rejects code ending in the delegate without the EIP-7702 prefix', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      chain: mainnet,
      transport: custom({
        async request() {
          return `0x000000${DELEGATE.slice(2)}`
        },
      }),
    })

    await expect(
      toFrameAccount({ client, owner, delegateAddress: DELEGATE }),
    ).rejects.toThrow(/expected 0xef0100/)
  })

  test('truncates long contract code in delegate mismatch errors', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const longCode = `0x${'12'.repeat(100)}` as const
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() { return longCode } }),
    })

    await expect(
      toFrameAccount({ client, owner, delegateAddress: DELEGATE }),
    ).rejects.toThrow(`${longCode.slice(0, 48)}...`)
  })

  test('reads the nonce from the resolved delegated address', async () => {
    const owner = privateKeyToP256Account(`0x${'01'.padStart(64, '0')}`)
    const requests: { method: string; params?: unknown }[] = []
    const client = createClient({
      chain: mainnet,
      transport: custom({
        async request(request) {
          requests.push(request)
          return '0x5'
        },
      }),
    })
    const account = await toFrameAccount({ client, owner, address: OTHER })

    expect(await account.getNonce()).toBe(5n)
    expect(requests).toEqual([
      { method: 'eth_getTransactionCount', params: [OTHER, 'pending'] },
    ])
  })

  test('does not prepend its entry after another entry has been signed', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const payerOwner = privateKeyToAccount(`0x${'22'.repeat(32)}`)
    const client = createClient({
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({ client, owner })
    const payerOnly = {
      ...GOLDEN_TX,
      sender: owner.address,
      signatures: [
        {
          scheme: 1 as const,
          signer: payerOwner.address,
          msg: '0x' as const,
          signature: '0x' as const,
        },
      ],
    }
    const payerSigned = await signFrameSignature(payerOnly, 0, payerOwner)

    await expect(account.signFrameTransaction(payerSigned)).rejects.toThrow(
      /other entries are already signed/,
    )
    expect(await recoverFrameSigner(payerSigned, 0)).toBe(payerOwner.address)
  })

  test('reads key 0 from the pending account nonce', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const requests: { method: string; params?: unknown }[] = []
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({
        async request(request) {
          requests.push(request)
          return '0x7'
        },
      }),
    })
    const account = await toFrameAccount({ client, owner })

    expect(await account.getNonce()).toBe(7n)
    expect(requests).toEqual([
      { method: 'eth_getTransactionCount', params: [owner.address, 'pending'] },
    ])
  })

  test('reads a non-zero key from its NONCE_MANAGER slot', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const requests: { method: string; params?: unknown }[] = []
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({
        async request(request) {
          requests.push(request)
          return `0x${'00'.repeat(31)}03`
        },
      }),
    })
    const account = await toFrameAccount({ client, owner })

    expect(await account.getNonce({ key: 5n, blockTag: 'latest' })).toBe(3n)
    // Slot computed independently: `cast keccak` over
    // left_pad_32(0x19E7…ff2A) || uint256(5).
    expect(requests).toEqual([
      {
        method: 'eth_getStorageAt',
        params: [
          '0x0000000000000000000000000000000000008250',
          '0x91532bb988e1829b215838c387168ecc92dc12a6ace9895d81f60d6eebf505d4',
          'latest',
        ],
      },
    ])
  })

  test('rejects a transaction whose sender is not the EOA', async () => {
    const owner = privateKeyToAccount(OWNER_KEY)
    const client = createClient({
      account: owner,
      chain: mainnet,
      transport: custom({ async request() {} }),
    })
    const account = await toFrameAccount({ client, owner })
    await expect(account.signFrameTransaction(GOLDEN_TX)).rejects.toThrow(
      /does not match frame account/,
    )
  })
})

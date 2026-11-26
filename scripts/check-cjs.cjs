// Loads the built CommonJS entries with require() and checks that a P-256
// account derived through them matches the one from the ESM build. The test
// suite imports from src/, so only this catches a CJS build that cannot load
// on the oldest Node release in `engines`.
const assert = require('node:assert/strict')

const key = `0x${'11'.repeat(32)}`
const hash = `0x${'22'.repeat(32)}`

async function main() {
  const cjs = require('../dist/index.cjs')
  const viem = require('../dist/viem.cjs')
  const esm = await import('../dist/index.js')

  assert.equal(typeof viem.frameActions, 'function')

  const fromCjs = cjs.privateKeyToP256Account(key)
  const fromEsm = esm.privateKeyToP256Account(key)
  assert.equal(fromCjs.address, fromEsm.address)
  assert.equal(await fromCjs.sign({ hash }), await fromEsm.sign({ hash }))

  console.log(`CJS build loads on Node ${process.version}: ${fromCjs.address}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

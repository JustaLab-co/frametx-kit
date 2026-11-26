import { defineConfig, type Options } from 'tsup'

const shared: Options = {
  entry: {
    index: 'src/index.ts',
    viem: 'src/viem.ts',
  },
  dts: true,
  sourcemap: true,
  treeshake: true,
  // viem stays external: consumers bring their own, and bundling it would
  // duplicate its secp256k1 and keccak implementations.
  external: ['viem'],
}

export default defineConfig([
  { ...shared, format: ['esm'], clean: true },
  // ox 1.x ships ESM only, and require() of an ES module needs Node 20.19 or
  // 22.12. Bundling it into the CJS build keeps require() working on Node 20.
  { ...shared, format: ['cjs'], noExternal: ['ox'] },
])

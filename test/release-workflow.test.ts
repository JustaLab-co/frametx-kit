import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

// The release job holds write credentials, so every tool it runs must come
// from the lockfile instead of being fetched from npm at release time.
// release.yml also runs ci.yml as the gate its release job needs.
const workflows = ['.github/workflows/release.yml', '.github/workflows/ci.yml']
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

describe('release workflow', () => {
  test.each(workflows)('%s runs attw from node_modules, never fetching it', (path) => {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => /\battw\b|arethetypeswrong/.test(l))
    expect(lines).toEqual(['        run: bunx --no-install attw --pack .'])
  })

  test('pins @arethetypeswrong/cli to an exact version', () => {
    expect(pkg.devDependencies['@arethetypeswrong/cli']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

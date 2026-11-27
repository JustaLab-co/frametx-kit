import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

// The release job holds write credentials, so every tool it runs must come
// from the lockfile instead of being fetched from npm at release time.
const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

describe('release workflow', () => {
  test('runs attw from node_modules, never fetching it', () => {
    const lines = workflow.split('\n').filter((l) => /\battw\b|arethetypeswrong/.test(l))
    expect(lines).toEqual(['        run: bunx --no-install attw --pack .'])
  })

  test('pins @arethetypeswrong/cli to an exact version', () => {
    expect(pkg.devDependencies['@arethetypeswrong/cli']).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

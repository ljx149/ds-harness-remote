#!/usr/bin/env node

import { existsSync } from 'node:fs'

// npm packs the standalone bundle; raw GitHub installs retain the Host entry.
const { runCli } = await import(existsSync(new URL('../dist/cli.bundle.js', import.meta.url))
  ? '../dist/cli.bundle.js' : '../dist/index.js')

runCli().then(
  code => { process.exitCode = code },
  error => {
    console.error(error instanceof Error ? error.message : 'The Remote command failed.')
    process.exitCode = 1
  },
)

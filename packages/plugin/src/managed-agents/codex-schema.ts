// Codex's version-specific schema generator is documented at
// https://developers.openai.com/codex/app-server#message-schema .
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const cache = new Map<string, Promise<ReadonlySet<string>>>()

export function codexSchemaMethods(schema: unknown): Set<string> {
  const methods = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const object = value as Record<string, unknown>
    const properties = object.properties as Record<string, unknown> | undefined
    const method = properties?.method as { const?: unknown; enum?: unknown } | undefined
    if (typeof method?.const === 'string') methods.add(method.const)
    if (Array.isArray(method?.enum)) for (const item of method.enum) if (typeof item === 'string') methods.add(item)
    Object.values(object).forEach(visit)
  }
  visit(schema)
  return methods
}

/** Read-only generator, never runs a conversation. Same resolved executable,
 * bounded lifetime/output, private temporary directory, no config/log copying. */
export async function discoverCodexMethods(binary: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<ReadonlySet<string>> {
  let executable: string | undefined
  for (const candidate of isAbsolute(binary) || binary.includes('/') ? [resolve(binary)] : ((options.env ?? process.env).PATH ?? '').split(delimiter).map(dir => join(dir, binary))) {
    try { await access(candidate, constants.X_OK); executable = await realpath(candidate); break } catch { /* next PATH entry */ }
  }
  if (!executable) return new Set()
  const info = await stat(executable)
  const key = `${executable}:${info.mtimeMs}:${info.size}`
  let pending = cache.get(key)
  if (!pending) {
    pending = generate(executable, options.env).catch(() => new Set<string>())
    cache.set(key, pending)
    if (cache.size > 8) cache.delete(cache.keys().next().value!)
  }
  return pending
}
async function generate(binary: string, env?: NodeJS.ProcessEnv): Promise<ReadonlySet<string>> {
  const directory = await mkdtemp(join(tmpdir(), 'xcodex-schema-'))
  try {
    await execute(binary, ['app-server', 'generate-json-schema', '--out', directory], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true, cwd: directory, env })
    const methods = new Set<string>()
    let bytes = 0
    let files = 0
    const read = async (path: string, depth: number): Promise<void> => {
      if (depth > 2) return
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        const file = join(path, entry.name)
        if (entry.isDirectory()) { await read(file, depth + 1); continue }
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        if (++files > 512) throw new Error('Codex schema file bound exceeded.')
        const size = (await stat(file)).size
        bytes += size
        if (bytes > 16 * 1024 * 1024) throw new Error('Codex schema size bound exceeded.')
        for (const method of codexSchemaMethods(JSON.parse(await readFile(file, 'utf8')))) methods.add(method)
      }
    }
    await read(directory, 0)
    return methods
  } finally { await rm(directory, { recursive: true, force: true }) }
}

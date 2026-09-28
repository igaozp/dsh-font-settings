// Host half of the DSH font-settings plugin.
//
// Responsibilities:
//   1. Enumerate the fonts actually installed on this machine (font-file name
//      tables, with a Windows-registry fallback) and cache the result.
//   2. Own the durable preference (`uiFont` / `codeFont`): the Host `settings`
//      service when this profile mounts it, the storage hub otherwise.
//   3. Expose a tiny same-origin JSON API that the browser half renders.
//
// The browser half may not read the filesystem, so enumeration lives here.
//
// NOTE ON CONFIG: this entry deliberately does NOT export a `Config` schema.
// Declaring one makes the boot layer auto-inject a `config` service, and nothing
// in the Host composition provides that name — the fiber then stays `pending`
// forever ("waiting for service: config") and the whole row never activates.
// The preference is therefore owned here and persisted explicitly instead.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const name = '@igaozp/dsh-font-settings'

/**
 * Hard dependency: the browser carrier the JSON API registers on.
 * `settings` and `storage` are optional and reached through `ctx.get()`.
 */
export const inject = ['webServer']

/**
 * The profile entry id doubles as the settings namespace, which is what the
 * Host `settings` service keys on. Keep the two in sync with the loader row.
 */
const NAMESPACE = '@igaozp/dsh-font-settings'

/** Font-container extensions worth parsing. `.ttc`/`.otc` hold collections. */
const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.otc']

/** Font directories to scan, newest Windows layouts first. */
function fontDirectories() {
  const dirs = []
  const winDir = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  if (process.platform === 'win32') {
    dirs.push(join(winDir, 'Fonts'))
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      // Windows 10 1809+ per-user font install target.
      dirs.push(join(localAppData, 'Microsoft', 'Windows', 'Fonts'))
    }
  } else if (process.platform === 'darwin') {
    dirs.push('/System/Library/Fonts', '/Library/Fonts')
    const home = process.env.HOME
    if (home) dirs.push(join(home, 'Library', 'Fonts'))
  } else {
    dirs.push('/usr/share/fonts', '/usr/local/share/fonts')
    const home = process.env.HOME
    if (home) dirs.push(join(home, '.local', 'share', 'fonts'), join(home, '.fonts'))
  }
  return dirs
}

/** Decode one OpenType name-table string into a JS string. */
function decodeNameRecord(bytes, platformId) {
  if (bytes.length === 0) return ''
  // Windows (3) and Unicode (0) platforms store UTF-16BE.
  if (platformId === 3 || platformId === 0) {
    const swapped = Buffer.allocUnsafe(bytes.length)
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      swapped[i] = bytes[i + 1]
      swapped[i + 1] = bytes[i]
    }
    return swapped.toString('utf16le')
  }
  return bytes.toString('latin1')
}

/**
 * Parse the `name` table of one font (or one font inside a collection) and
 * return its family names plus a ready-to-use CSS stack.
 *
 * @param buf - whole font file.
 * @param offset - start of the font's offset table (0, or a TTC entry offset).
 * @returns a font entry, or null when the file is not a readable font.
 */
function parseFont(buf, offset) {
  if (buf.length < 12 || offset < 0 || offset + 12 > buf.length) return null
  const numTables = buf.readUInt16BE(offset + 4)
  let nameTableOffset = 0
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + i * 16
    if (rec + 16 > buf.length) return null
    // tag 'name'
    if (buf.readUInt32BE(rec) === 0x6e616d65) {
      nameTableOffset = buf.readUInt32BE(rec + 8)
      break
    }
  }
  if (nameTableOffset <= 0 || nameTableOffset + 6 > buf.length) return null

  const count = buf.readUInt16BE(nameTableOffset + 2)
  const stringOffset = buf.readUInt16BE(nameTableOffset + 4)
  const stringsBase = nameTableOffset + stringOffset

  /** @type {{family:string, subfamily:string, full:string, english:boolean, rank:number}[]} */
  const records = []
  for (let i = 0; i < count; i++) {
    const rec = nameTableOffset + 6 + i * 12
    if (rec + 12 > buf.length) break
    const platformId = buf.readUInt16BE(rec)
    const languageId = buf.readUInt16BE(rec + 4)
    const nameId = buf.readUInt16BE(rec + 6)
    const length = buf.readUInt16BE(rec + 8)
    const strOffset = buf.readUInt16BE(rec + 10)
    if (nameId !== 1 && nameId !== 2 && nameId !== 4) continue
    const start = stringsBase + strOffset
    if (length === 0 || start + length > buf.length) continue
    const text = decodeNameRecord(buf.subarray(start, start + length), platformId)
      .replace(/\u0000/g, '')
      .trim()
    if (!text) continue
    // Prefer Windows/English records so the stored family name stays stable.
    const english = (platformId === 3 && languageId === 0x0409) || (platformId === 1 && languageId === 0)
    const rank = english ? 3 : platformId === 3 || platformId === 0 ? 2 : 1
    records.push({ nameId, text, english, rank })
  }
  if (records.length === 0) return null

  const best = (nameId) => {
    const candidates = records.filter((r) => r.nameId === nameId)
    if (candidates.length === 0) return ''
    candidates.sort((a, b) => b.rank - a.rank || a.text.length - b.text.length)
    return candidates[0].text
  }

  const family = best(1) || best(4)
  if (!family) return null
  const full = best(4) || family
  const subfamily = best(2)
  const hasEnglish = records.some((r) => r.english)

  // Family names containing a comma ("Foo, Bold") carry the style in the name;
  // the style-free prefix is the usable font-family value.
  const baseFamily = family.includes(',') ? family.slice(0, family.indexOf(',')).trim() || family : family

  return { family, baseFamily, full, subfamily, hasEnglish, localized: hasEnglish ? '' : family }
}

/** Collect every font entry inside one file (collections yield several). */
function readFontFile(path) {
  const out = []
  let buf
  try {
    const stat = statSync(path)
    if (stat.size <= 0 || stat.size > 64 * 1024 * 1024) return out
    buf = readFileSync(path)
  } catch {
    return out
  }
  const tag = buf.length >= 4 ? buf.toString('latin1', 0, 4) : ''
  try {
    if (tag === 'ttcf') {
      const count = buf.readUInt32BE(8)
      for (let i = 0; i < count; i++) {
        const pos = 12 + i * 4
        if (pos + 4 > buf.length) break
        const entry = parseFont(buf, buf.readUInt32BE(pos))
        if (entry) out.push(entry)
      }
    } else if (tag === '\u0000\u0001\u0000\u0000' || tag === 'OTTO' || tag === 'true' || tag === 'typ1') {
      const entry = parseFont(buf, 0)
      if (entry) out.push(entry)
    }
  } catch {
    // A malformed font must never break enumeration.
  }
  return out
}

/**
 * Registry fallback: Windows exposes friendly display names for installed
 * fonts that a name-table scan cannot always reproduce.
 */
async function registryFamilies(ctx) {
  const subprocess = ctx.get('subprocess')
  if (!subprocess || process.platform !== 'win32') return []
  let executable
  try {
    executable = await subprocess.resolveExecutable('pwsh')
  } catch {
    try {
      executable = await subprocess.resolveExecutable('powershell')
    } catch {
      return []
    }
  }
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$keys=@(',
    '"HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",',
    '"HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts")',
    'Get-ItemProperty -Path $keys | ForEach-Object { $_.PSObject.Properties |',
    ' Where-Object { $_.Name -notlike "PS*" } | ForEach-Object { $_.Name } } |',
    ' Sort-Object -Unique',
  ].join(' ')
  try {
    const handle = subprocess.spawn({
      argv: [executable, '-NoProfile', '-NonInteractive', '-Command', script],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 512 * 1024 }, stderr: { maxBytes: 16 * 1024 } },
      graceMs: 4000,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return []
    const stdout = handle.collected && handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null
    const text = stdout && stdout.text ? stdout.text : ''
    const names = []
    for (const raw of text.split(/\r?\n/)) {
      let label = raw.trim()
      if (!label) continue
      // Registry values look like "Microsoft YaHei UI (TrueType)".
      label = label.replace(/\s*\((TrueType|OpenType|All res|VGA res|PostScript[^)]*)\)\s*$/i, '').trim()
      if (!label) continue
      // Strip a trailing style so variants collapse onto one family.
      names.push(label)
    }
    return names
  } catch {
    return []
  }
}

/** Normalize a family name into a stable grouping key. */
function familyKey(name) {
  return name.replace(/\s+/g, ' ').trim().toLowerCase()
}

const SYSTEM_DEFAULT = ''

/** Fonts most users want first in the picker. */
const PREFERRED = [
  'system-ui', 'segoe ui', 'microsoft yahei ui', 'microsoft yahei', 'pingfang sc',
  'sf pro text', 'helvetica neue', 'arial', 'inter',
]
const PREFERRED_CODE = [
  'cascadia code', 'cascadia mono', 'consolas', 'jetbrains mono', 'fira code',
  'sf mono', 'menlo', 'source code pro', 'ibm plex mono', 'courier new', 'monospace',
]

/** Order the catalog: shipped defaults, preferred families, then alphabetical. */
function sortCatalog(rows, preferred) {
  const rank = (row) => {
    const key = familyKey(row.family)
    const index = preferred.indexOf(key)
    if (index >= 0) return index
    return preferred.length + 1
  }
  rows.sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return a.family.localeCompare(b.family, 'en', { sensitivity: 'base' })
  })
  return rows
}

/** Build one catalog row from the raw parse result of a font file. */
function toRow(entry) {
  const family = entry.baseFamily || entry.family
  return {
    family,
    label: family,
    localized: entry.localized && familyKey(entry.localized) !== familyKey(family) ? entry.localized : '',
    full: entry.full,
    style: entry.subfamily,
    css: '"' + family.replace(/"/g, '\\"') + '"',
  }
}

/**
 * Enumerate installed fonts from disk, merging duplicates by family.
 * @returns {Promise<{fonts:object[], sources:string[], warnings:string[]}>}
 */
async function enumerateFonts(ctx) {
  const warnings = []
  const sources = []
  /** @type {Map<string, any>} */
  const byFamily = new Map()

  for (const dir of fontDirectories()) {
    let names
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    sources.push(dir)
    for (const fileName of names) {
      const lower = fileName.toLowerCase()
      if (!FONT_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
      for (const entry of readFontFile(join(dir, fileName))) {
        const row = toRow(entry)
        const key = familyKey(row.family)
        if (!key) continue
        const existing = byFamily.get(key)
        if (!existing) {
          byFamily.set(key, row)
          continue
        }
        // Prefer an English label and fill in a missing localized alias.
        if (!existing.localized && row.localized) existing.localized = row.localized
        if (existing.label !== row.label && row.localized && !existing.localized) existing.localized = row.label
      }
    }
  }

  const registry = await registryFamilies(ctx)
  if (registry.length > 0) {
    sources.push('registry')
    for (const label of registry) {
      const key = familyKey(label)
      if (!key || byFamily.has(key)) continue
      byFamily.set(key, { family: label, label, localized: '', full: label, style: '', css: '"' + label.replace(/"/g, '\\"') + '"' })
    }
  }

  if (byFamily.size === 0) warnings.push('未从本机字体目录读取到任何字体。')

  const fonts = [...byFamily.values()]
  const ui = sortCatalog(fonts.map((f) => ({ ...f })), PREFERRED)
  const code = sortCatalog(fonts.map((f) => ({ ...f })), PREFERRED_CODE)
  return { fonts: ui, codeFonts: code, sources, warnings }
}

export function apply(ctx) {
  const settings = ctx.get('settings')
  const storage = ctx.get('storage')

  /** @type {{uiFont:string, codeFont:string}} */
  let current = { uiFont: '', codeFont: '' }
  let loading = null
  let persistError = null
  let persistedTo = settings ? 'settings' : 'none'

  let catalog = null
  let catalogAt = 0
  let scanning = null
  const CATALOG_TTL = 5 * 60 * 1000

  // ---- storage-hub fallback (only used when the settings write is refused) --
  const UNIT = { name: 'dsh_fonts', version: 1, tables: ['preference'], hasGlobal: false }
  let preferenceUnit = null
  let storageOpening = null

  function openPreferenceUnit() {
    if (preferenceUnit || storageOpening) return storageOpening || Promise.resolve(preferenceUnit)
    storageOpening = (async () => {
      try {
        if (!storage || !storage.backend) return null
        if (storage.backend.names().indexOf('json') === -1) return null
        const backend = storage.backend.get('json')
        if (!backend || !backend.kv) return null
        const unit = await backend.kv.open(UNIT)
        preferenceUnit = unit
        return unit
      } catch {
        return null
      } finally {
        storageOpening = null
      }
    })()
    return storageOpening
  }

  ctx.effect(() => () => {
    const unit = preferenceUnit
    preferenceUnit = null
    if (unit) unit.close().catch(() => {})
  })

  async function readStorage() {
    try {
      const unit = await openPreferenceUnit()
      if (!unit) return null
      const loaded = await unit.loadAll()
      const row = loaded && loaded.tables && loaded.tables.preference ? loaded.tables.preference.totals : null
      if (!row || typeof row !== 'object') return null
      return {
        uiFont: typeof row.uiFont === 'string' ? row.uiFont : '',
        codeFont: typeof row.codeFont === 'string' ? row.codeFont : '',
      }
    } catch {
      return null
    }
  }

  async function writeStorage(value) {
    try {
      const unit = await openPreferenceUnit()
      if (!unit) return false
      await unit.putRecord('preference', 'totals', { uiFont: value.uiFont, codeFont: value.codeFont, savedAt: Date.now() })
      return true
    } catch {
      return false
    }
  }

  // ---- durable preference -------------------------------------------------

  /**
   * Look this entry up in the Host settings service.
   *
   * Exported `Config` would have made the settings service own this namespace,
   * but declaring one hangs the row (see the note at the top of this file), so
   * the namespace is normally absent. That is an expected state, not a failure:
   * it just means the storage hub is the durable store.
   *
   * @returns the descriptor, or null when settings does not serve this namespace.
   */
  function settingsDescriptor() {
    if (!settings) return null
    try {
      return settings.describe().find((d) => d.ns === NAMESPACE) || null
    } catch {
      return null
    }
  }

  /**
   * Resolve the effective preference once, in precedence order:
   *   1. the Host settings descriptor, when this profile serves the namespace,
   *   2. the storage hub — the durable store for every other profile.
   */
  function loadStored() {
    if (loading) return loading
    loading = (async () => {
      const descriptor = settingsDescriptor()
      const value = descriptor && descriptor.value && typeof descriptor.value === 'object' ? descriptor.value : null
      if (value) {
        current = {
          uiFont: typeof value.uiFont === 'string' ? value.uiFont : '',
          codeFont: typeof value.codeFont === 'string' ? value.codeFont : '',
        }
        persistedTo = 'settings'
      } else if (settings) {
        persistedTo = 'storage'
      }

      if (current.uiFont || current.codeFont) return
      const fallback = await readStorage()
      if (fallback && (fallback.uiFont || fallback.codeFont)) {
        current = fallback
        persistedTo = 'storage'
      }
    })()
    return loading
  }

  /**
   * Persist the preference. The settings service is tried first only when it
   * actually serves this namespace; otherwise — and on any refusal — the value
   * goes to the storage hub. Memory is the last resort and the only case that
   * reports an error, because only then is the choice really not durable.
   */
  async function persist(next) {
    current = next
    const descriptor = settingsDescriptor()
    if (descriptor) {
      try {
        await settings.update(
          NAMESPACE,
          { uiFont: next.uiFont, codeFont: next.codeFont },
          descriptor.revision,
        )
        persistedTo = 'settings'
        persistError = null
        return
      } catch (e) {
        persistError = String((e && e.message) || e)
      }
    }

    if (await writeStorage(next)) {
      persistedTo = 'storage'
      // A refused settings write is not worth surfacing when the fallback
      // succeeded: the choice IS durable.
      persistError = null
      return
    }

    persistedTo = 'memory'
    persistError = persistError || '无法持久化字体设置，当前仅在本次运行内生效。'
  }

  // ---- font catalog -------------------------------------------------------

  function scanCatalog(force) {
    if (!force && catalog && Date.now() - catalogAt < CATALOG_TTL) return Promise.resolve(catalog)
    if (scanning) return scanning
    scanning = (async () => {
      try {
        const result = await enumerateFonts(ctx)
        catalog = result
        catalogAt = Date.now()
      } catch (e) {
        catalog = { fonts: [], codeFonts: [], sources: [], warnings: ['字体扫描失败：' + String((e && e.message) || e)] }
        catalogAt = Date.now()
      } finally {
        scanning = null
      }
      return catalog
    })()
    return scanning
  }

  // ---- HTTP API -----------------------------------------------------------

  function send(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          resolve(null)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        if (!text) return resolve({})
        try {
          resolve(JSON.parse(text))
        } catch {
          resolve(null)
        }
      })
      req.on('error', () => resolve(null))
    })
  }

  async function statePayload(force) {
    await loadStored()
    const list = await scanCatalog(force)
    const warnings = [...list.warnings]
    if (persistError) warnings.push('持久化：' + persistError)
    return {
      uiFont: current.uiFont,
      codeFont: current.codeFont,
      persistedTo,
      persistError,
      count: list.fonts.length,
      sources: list.sources,
      warnings,
      scannedAt: catalogAt,
    }
  }

  async function stateRoute(req, res) {
    if (req.method === 'GET') {
      send(res, 200, await statePayload(false))
      return
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' })
      return
    }
    const body = await readBody(req)
    if (!body) {
      send(res, 400, { error: 'invalid JSON body' })
      return
    }
    await loadStored()
    const list = await scanCatalog(false)
    const known = new Set(list.fonts.map((f) => f.family))
    const next = { ...current }
    for (const field of ['uiFont', 'codeFont']) {
      if (!(field in body)) continue
      const value = body[field]
      if (typeof value !== 'string') {
        send(res, 400, { error: field + ' 必须是字符串' })
        return
      }
      if (value !== SYSTEM_DEFAULT && !known.has(value)) {
        send(res, 400, { error: '未安装的字体：' + value })
        return
      }
      next[field] = value
    }
    await persist(next)
    send(res, 200, await statePayload(false))
  }

  async function fontsRoute(req, res) {
    const force = req.method === 'POST'
    await loadStored()
    const list = await scanCatalog(force)
    send(res, 200, {
      fonts: list.fonts,
      codeFonts: list.codeFonts,
      sources: list.sources,
      warnings: list.warnings,
      scannedAt: catalogAt,
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-fonts/state',
    handler: stateRoute,
  }), 'font-settings: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-fonts/fonts',
    handler: fontsRoute,
  }), 'font-settings: fonts route')

  // Warm the preference read so the first browser call is cheap. The catalog is
  // deliberately lazy: it reads a few thousand font files.
  loadStored()
}

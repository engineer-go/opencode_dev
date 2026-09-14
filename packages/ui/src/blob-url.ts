// Object URLs pin their Blob in memory until `URL.revokeObjectURL` runs. This cache
// keeps a URL alive while any owner holds a reference (`refs > 0`) and moves it to a
// bounded idle pool once the last owner releases it. Idle entries are only revoked
// when the pool exceeds its limits, so a URL that is about to be re-referenced is not
// torn down in between.

type Entry = { url: string; bytes: number; refs: number }

const MAX_IDLE_ENTRIES = 200
const MAX_IDLE_BYTES = 64 * 1024 * 1024

const entries = new Map<string, Entry>()
const idle = new Map<string, number>()
let idleBytes = 0

function sweepIdle() {
  while (idle.size > MAX_IDLE_ENTRIES || idleBytes > MAX_IDLE_BYTES) {
    const oldest = idle.keys().next().value
    if (oldest === undefined) return
    idle.delete(oldest)
    const entry = entries.get(oldest)
    if (!entry) continue
    idleBytes -= entry.bytes
    entries.delete(oldest)
    URL.revokeObjectURL(entry.url)
  }
}

export function blobUrl(id: string, blob: Blob): string {
  const existing = entries.get(id)
  if (existing) return existing.url
  const url = URL.createObjectURL(blob)
  entries.set(id, { url, bytes: blob.size, refs: 0 })
  idle.set(id, blob.size)
  idleBytes += blob.size
  sweepIdle()
  return url
}

export function retainBlobUrl(id: string): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  if (entry.refs === 0) {
    idle.delete(id)
    idleBytes -= entry.bytes
  }
  entry.refs += 1
  return true
}

export function releaseBlobUrl(id: string): void {
  const entry = entries.get(id)
  if (!entry || entry.refs === 0) return
  entry.refs -= 1
  if (entry.refs > 0) return
  idle.set(id, entry.bytes)
  idleBytes += entry.bytes
  sweepIdle()
}

export function releaseBlobUrls(ids: Iterable<string>): void {
  for (const id of ids) releaseBlobUrl(id)
}

export function resetBlobUrlCache(): void {
  for (const entry of entries.values()) URL.revokeObjectURL(entry.url)
  entries.clear()
  idle.clear()
  idleBytes = 0
}

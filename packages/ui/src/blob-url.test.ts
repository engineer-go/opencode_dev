import { beforeEach, describe, expect, test } from "bun:test"
import { blobUrl, releaseBlobUrl, releaseBlobUrls, resetBlobUrlCache, retainBlobUrl } from "./blob-url"

const blob = new Blob([new Uint8Array(8)])
let created: string[]
let revoked: string[]

beforeEach(() => {
  resetBlobUrlCache()
  created = []
  revoked = []
  Object.assign(URL, {
    createObjectURL: () => {
      const url = `blob:${created.length + 1}`
      created.push(url)
      return url
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url)
    },
  })
})

describe("blobUrl", () => {
  test("reuses the url for the same id", () => {
    const first = blobUrl("a", blob)
    const second = blobUrl("a", blob)
    expect(second).toBe(first)
    expect(created).toEqual([first])
  })

  test("keeps a retained url when idle entries are evicted", () => {
    const kept = blobUrl("keep", blob)
    retainBlobUrl("keep")
    for (let index = 0; index <= 200; index++) blobUrl(`idle-${index}`, blob)
    expect(revoked).not.toContain(kept)
  })

  test("revokes an idle url once the idle pool overflows", () => {
    const idle = blobUrl("idle", blob)
    for (let index = 0; index <= 200; index++) blobUrl(`filler-${index}`, blob)
    expect(revoked).toContain(idle)
  })

  test("reuses a released url while it is still idle", () => {
    const first = blobUrl("a", blob)
    retainBlobUrl("a")
    releaseBlobUrl("a")
    expect(blobUrl("a", blob)).toBe(first)
    expect(created).toEqual([first])
  })

  test("release is a no-op without a matching retain", () => {
    const url = blobUrl("a", blob)
    releaseBlobUrl("a")
    expect(blobUrl("a", blob)).toBe(url)
    expect(created).toEqual([url])
  })

  test("releaseBlobUrls releases every id", () => {
    const a = blobUrl("a", blob)
    const b = blobUrl("b", blob)
    retainBlobUrl("a")
    retainBlobUrl("b")
    releaseBlobUrls(["a", "b"])
    for (let index = 0; index <= 200; index++) blobUrl(`filler-${index}`, blob)
    expect(revoked).toContain(a)
    expect(revoked).toContain(b)
  })
})

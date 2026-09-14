import { beforeEach, describe, expect, test } from "bun:test"
import { resetBlobUrlCache } from "@opencode-ai/ui/blob-url"
import { createDraftStore } from "./draft-store"

function createDriver() {
  const documents = new Map<string, string>()
  const blobs = new Map<string, Blob>()
  let next = 0
  return {
    get: async (key: string) => documents.get(key) ?? null,
    set: async (key: string, value: string) => {
      documents.set(key, value)
    },
    remove: async (key: string) => {
      documents.delete(key)
    },
    putBlob: async (blob: Blob) => {
      const id = `blob-${++next}`
      blobs.set(id, blob)
      return id
    },
    getBlob: async (id: string) => blobs.get(id) ?? null,
    seedDocument(key: string, value: string) {
      documents.set(key, value)
    },
    seedBlob(id: string, blob: Blob) {
      blobs.set(id, blob)
    },
  }
}

let revoked: string[]
let created: string[]

beforeEach(() => {
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
  resetBlobUrlCache()
  revoked = []
})

async function fillIdleCache(store: ReturnType<typeof createDraftStore>, count: number) {
  for (let index = 0; index < count; index++) await store.putBlob(new Blob([new Uint8Array([index % 256])]))
}

describe("draft store blob urls", () => {
  test("keeps a URL alive while a persisted item references it", async () => {
    const driver = createDriver()
    const store = createDraftStore(driver)
    const ref = await store.putBlob(new Blob([new Uint8Array([1])]))
    await store.setItem("draft:prompt", JSON.stringify([{ type: "image", blob: { id: ref.id, url: ref.url } }]))

    await fillIdleCache(store, 250)
    expect(revoked).not.toContain(ref.url)
  })

  test("releases a URL once the attachment is removed", async () => {
    const driver = createDriver()
    const store = createDraftStore(driver)
    const ref = await store.putBlob(new Blob([new Uint8Array([1])]))
    await store.setItem("draft:prompt", JSON.stringify([{ type: "image", blob: { id: ref.id, url: ref.url } }]))
    await store.setItem("draft:prompt", JSON.stringify([]))

    await fillIdleCache(store, 250)
    expect(revoked).toContain(ref.url)
  })

  test("retains a URL loaded from a persisted item", async () => {
    const driver = createDriver()
    const store = createDraftStore(driver)
    const blob = new Blob([new Uint8Array([1])])
    driver.seedBlob("blob-loaded", blob)
    driver.seedDocument("draft:prompt", JSON.stringify([{ type: "image", blob: { id: "blob-loaded" } }]))

    await store.getItem("draft:prompt")
    const url = created.at(-1)!
    await fillIdleCache(store, 250)
    expect(revoked).not.toContain(url)
  })

  test("releases a URL when the persisted item is removed", async () => {
    const driver = createDriver()
    const store = createDraftStore(driver)
    const blob = new Blob([new Uint8Array([1])])
    driver.seedBlob("blob-loaded", blob)
    driver.seedDocument("draft:prompt", JSON.stringify([{ type: "image", blob: { id: "blob-loaded" } }]))
    await store.getItem("draft:prompt")
    const url = created.at(-1)!

    await store.removeItem("draft:prompt")
    await fillIdleCache(store, 250)
    expect(revoked).toContain(url)
  })

  test("keeps a shared URL while any persisted item still references it", async () => {
    const driver = createDriver()
    const store = createDraftStore(driver)
    const ref = await store.putBlob(new Blob([new Uint8Array([1])]))
    await store.setItem("draft:a", JSON.stringify([{ type: "image", blob: { id: ref.id, url: ref.url } }]))
    await store.setItem("draft:b", JSON.stringify([{ type: "image", blob: { id: ref.id, url: ref.url } }]))
    await store.setItem("draft:a", JSON.stringify([]))

    await fillIdleCache(store, 250)
    expect(revoked).not.toContain(ref.url)
  })
})

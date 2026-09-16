export function isAbsolutePath(path: string) {
  return path.startsWith("/")
}

export function resolveRevealPath(input: string, directory: string, home: string) {
  const path = input.trim()
  if (!path) return ""
  if (path === "~") return home || path
  if (path.startsWith("~/")) return home ? `${trimTrailingSlash(home)}/${path.slice(2)}` : path
  if (isAbsolutePath(path)) return path
  if (!directory) return path
  return `${trimTrailingSlash(directory)}/${path}`
}

function trimTrailingSlash(value: string) {
  let end = value.length
  while (end > 1 && value[end - 1] === "/") end--
  return value.slice(0, end)
}

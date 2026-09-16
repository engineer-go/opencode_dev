import { createContext, useContext, type ParentProps } from "solid-js"

export type FileActions = {
  revealPath?: (path: string) => void
}

const Context = createContext<FileActions>({})

export function FileActionsProvider(props: ParentProps<FileActions>) {
  const value: FileActions = {
    get revealPath() {
      return props.revealPath
    },
  }
  return <Context.Provider value={value}>{props.children}</Context.Provider>
}

export function useFileActions() {
  return useContext(Context)
}

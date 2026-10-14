const HANDLE = /"handle"\s*:\s*"(term_[^"]+)"/

export function createdHandle(stdout: string): string | undefined {
  return HANDLE.exec(stdout)?.[1]
}

export function previewHandles(listStdout: string, path: string): string[] {
  const terminals = (() => {
    try {
      return (JSON.parse(listStdout) as { result?: { terminals?: Array<{ handle?: string; tabId?: string; preview?: string }> } }).result?.terminals ?? []
    } catch {
      return []
    }
  })()
  const mentions = new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`)
  const seen = new Set<string>()
  return terminals.filter(terminal => {
    if (!terminal.handle || !mentions.test(terminal.preview ?? '') || seen.has(terminal.tabId ?? terminal.handle)) return false
    seen.add(terminal.tabId ?? terminal.handle)
    return true
  }).map(terminal => terminal.handle as string)
}

export type ReviewKitRun = { pr: number | undefined; status: 'active' | 'done' | 'aborted'; isOwn: boolean; state: string; head: string }
export type ReviewKitGatedAgent = { manifest?: string; pr: number; role: 'correctness' | 'quality' | 'refuter' | 'triage'; read: string[]; returns: number; passed: boolean }

declare module 'claude-code' {
  interface PluginState {
    'review-kit': {
      run: ReviewKitRun
      gatedAgent: StateFamily<ReviewKitGatedAgent>
      commitPending: boolean
      commitTurn: boolean
      sessionFiles: string[]
    }
  }
}

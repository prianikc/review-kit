export type ReviewKitRun = { pr: number | undefined; status: 'active' | 'done' | 'aborted'; isOwn: boolean; state: string; head: string }
export type ReviewKitPublishMark = { action: 'publish-review' | 'publish-replies'; pr: number; payload: string; payloadText: string }
export type ReviewKitGatedAgent = { manifest?: string; pr: number; role: 'correctness' | 'quality' | 'refuter' | 'triage'; read: string[]; returns: number; passed: boolean }
export type ReviewKitUsageRow = { at: string; pr: number; session: string; agentId: string | null; turnId: string; index: number; model: string; input: number; output: number; cacheRead: number; cacheCreation: number }
export type ReviewKitMark = { action: 'commit-push'; pr: number; branch: string; baseHead: string; message: string; paths: string[] }

declare module 'claude-code' {
  interface PluginState {
    'review-kit': {
      run: ReviewKitRun
      marks: Record<number, ReviewKitMark>
      publishMarks: Record<string, ReviewKitPublishMark>
      gatedAgent: StateFamily<ReviewKitGatedAgent>
      usage: Record<number, ReviewKitUsageRow[]>
      usageDrain: number | null
    }
  }
}

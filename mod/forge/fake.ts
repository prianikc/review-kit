import type { Comment, ForgeProvider, PullRequest, Reply, Review, ReviewDraft, Thread } from './types.ts'

export interface FakeData {
  me: string
  pulls: PullRequest[]
  commits?: Record<string, string>
  reviews?: Record<number, Review[]>
  threads?: Record<number, { threads: Thread[]; general: Comment[] }>
}

export type FakeProvider = ForgeProvider & {
  published: Array<{ number: number; draft: ReviewDraft }>
  replied: Array<{ number: number; replies: Reply[] }>
}

export function fakeProvider(data: FakeData): FakeProvider {
  const published: FakeProvider['published'] = []
  const replied: FakeProvider['replied'] = []
  const pull = (number: number): PullRequest => {
    const found = data.pulls.find(item => item.number === number)
    if (!found) throw new Error(`PR ${number} не найден`)
    return found
  }
  return {
    name: 'Fake',
    capabilities: { inline: true, requestChanges: true },
    published,
    replied,
    currentUser: async () => data.me,
    listPulls: async state => data.pulls.filter(item => item.state === state),
    getPull: async number => pull(number),
    commitDate: async sha => data.commits?.[sha] ?? '',
    listReviews: async number => data.reviews?.[number] ?? [],
    listThreads: async number => data.threads?.[number] ?? { threads: [], general: [] },
    publishReview: async (number, draft) => {
      published.push({ number, draft })
      return { url: `fake://${number}/review/${published.length}` }
    },
    publishReplies: async (number, replies) => {
      replied.push({ number, replies })
    },
    pullRef: number => `refs/pull/${number}/head`,
  }
}

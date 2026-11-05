import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commitAndPush, commitFiles, fetchPullRequestHead, syncKeepingLocalCommits } from './conflicts.js';
import type { OverviewActions, PickedSuggestion } from './pullRequestOverview.js';
import type { PullRequestConversation, PullRequestDetails, PullRequestProvider, RemoteThread } from './pullRequests.js';
import { applyLineSuggestions, parseSuggestions, type LineSuggestion } from './suggestions.js';
import { git } from './worktrees.js';

/** What the review page's GitHub actions need from the page that runs them. */
export interface PageContext {
  readonly provider: PullRequestProvider;
  readonly number: number;
  readonly headBranch: string;
  readonly baseBranch: () => string;
  /** The PR's worktree, or your own checkout. */
  readonly folder: string;
  /** Set for your own checkout: suggestions become local commits, and the checkout never moves to GitHub's head. */
  readonly keepCheckout?: boolean;
  /** Skip Git hooks when committing, for someone else's PR. */
  readonly hooksOff: boolean;
  details(): Promise<PullRequestDetails>;
  conversation(): Promise<PullRequestConversation>;
  /** Read GitHub's review threads again. */
  threads(): Promise<readonly RemoteThread[]>;
  pushTarget(details: PullRequestDetails): string;
  claudeBusy(): boolean;
  /** Reload the page's GitHub state after a change; `listed` also refreshes the sidebar, for changes it shows. */
  reload(listed?: boolean): void;
  /** Use a new base branch for the diff. */
  useBase(branch: string): Promise<void>;
}

export type GitHubPageActions = Pick<OverviewActions, 'addComment' | 'editComment' | 'deleteIssueComment' | 'hideComment' | 'react' | 'discardReview' | 'dismissReview'
  | 'rerequestReview' | 'updateBranch' | 'enableAutoMerge' | 'disableAutoMerge' | 'enqueue' | 'dequeue' | 'revert' | 'restoreBranch' | 'rerun' | 'approveRuns'
  | 'branches' | 'changeBase' | 'renderMarkdown' | 'commitSuggestions'>;

/** The review page's actions on GitHub conversations, reviews, the merge box and checks. */
export function githubPageActions(context: PageContext): GitHubPageActions {
  const { provider, number } = context;
  return {
    addComment: async (text) => {
      await provider.addComment(number, text);
      context.reload();
    },
    editComment: async (kind, id, text) => {
      await provider.editComment(kind, id, text);
      context.reload();
    },
    deleteIssueComment: async (id) => {
      await provider.deleteIssueComment(id);
      context.reload();
    },
    hideComment: async (id, reason) => {
      await provider.hideComment(id, reason);
      context.reload();
    },
    react: async (subject, content, on) => {
      await provider.react(subject, content, on);
      context.reload();
    },
    discardReview: async () => {
      await provider.discardPendingReview(number);
      context.reload();
    },
    dismissReview: async (login, reason) => {
      const review = (await context.conversation()).reviewIds[login];
      if (review === undefined) throw new Error(`${login} has no review to dismiss.`);
      await provider.dismissReview(review, reason);
      context.reload(true);
    },
    rerequestReview: async (login) => {
      await provider.requestReviewers(number, { users: [login], teams: [] });
      context.reload();
    },
    updateBranch: async (method) => {
      await provider.updateBranch(number, method);
      context.reload(true);
    },
    enableAutoMerge: async (method, message) => {
      await provider.enableAutoMerge(number, method, message);
      context.reload();
    },
    disableAutoMerge: async () => {
      await provider.disableAutoMerge(number);
      context.reload();
    },
    enqueue: async () => {
      await provider.enqueue(number);
      context.reload();
    },
    dequeue: async () => {
      await provider.dequeue(number);
      context.reload();
    },
    revert: async () => {
      const created = await provider.revert(number);
      context.reload(true);
      return created;
    },
    restoreBranch: async () => {
      const { merge } = await context.conversation();
      if (!merge.headDeleted || merge.headOid === '') throw new Error('The head branch still exists.');
      await provider.restoreBranch(context.headBranch, merge.headOid);
      context.reload();
    },
    rerun: async (runId) => {
      await provider.rerunFailedJobs(runId);
      context.reload();
    },
    approveRuns: async () => {
      const { awaitingApproval } = await context.conversation();
      for (const run of awaitingApproval) await provider.approveWorkflowRun(run);
      context.reload();
    },
    branches: async () => (await provider.branches()).filter((name) => name !== context.baseBranch() && name !== context.headBranch),
    changeBase: async (picked) => {
      const branches = (await provider.branches()).filter((name) => name !== context.baseBranch() && name !== context.headBranch);
      if (!branches.includes(picked)) throw new Error(`${picked} is not a branch this PR can merge into.`);
      await provider.changeBase(number, picked);
      await context.useBase(picked);
      context.reload(true);
    },
    renderMarkdown: (text) => provider.renderMarkdown(text),
    commitSuggestions: async (picked) => {
      if (context.claudeBusy()) throw new Error('Claude is working on this PR. Commit the suggestions when it is done.');
      const details = await context.details();
      if (!details.canEdit) throw new Error('You cannot push to this PR.');
      const edits = suggestionEdits(await context.threads(), picked);
      const paths = [...edits.keys()];
      if ((await git(context.folder, ['status', '--porcelain', '--', ...paths])).trim() !== '') throw new Error('Files these suggestions change have uncommitted changes. Commit or discard them first.');
      const { head, ahead } = context.keepCheckout === true ? { head: await fetchPullRequestHead(context.folder, number), ahead: true }
        : await syncKeepingLocalCommits(context.folder, number);
      const moved = ahead ? (await git(context.folder, ['diff', '--name-only', head, 'HEAD', '--', ...paths])).trim() : '';
      if (moved) throw new Error(`Unpushed commits change ${moved.split('\n').join(', ')}, so the suggestion's lines may have moved. Push them first.`);
      const before = new Map<string, string>();
      try {
        for (const [path, suggestions] of edits) {
          const file = join(context.folder, path);
          const text = await readFile(file, 'utf8');
          before.set(path, text);
          await writeFile(file, applyLineSuggestions(text, suggestions));
        }
      } catch (error: unknown) {
        for (const [path, text] of before) await writeFile(join(context.folder, path), text);
        throw error;
      }
      const commit = { path: paths, message: picked.length === 1 ? 'Apply suggestion from code review' : 'Apply suggestions from code review', hooksOff: context.hooksOff };
      if (ahead) await commitFiles(context.folder, commit);
      else await commitAndPush(context.folder, { ...commit, pushTo: context.pushTarget(details), headBranch: context.headBranch });
      context.reload(true);
    },
  };
}

/** Each picked suggestion's lines and code, by file; refuses outdated threads and comments without exactly one suggestion. */
export function suggestionEdits(threads: readonly RemoteThread[], picked: readonly PickedSuggestion[]): ReadonlyMap<string, readonly LineSuggestion[]> {
  const edits = new Map<string, LineSuggestion[]>();
  for (const { thread: threadId, comment: commentId } of picked) {
    const thread = threads.find((entry) => entry.id === threadId);
    const comment = thread?.comments.find((entry) => entry.id === commentId);
    const suggestions = parseSuggestions(comment?.body ?? '');
    const [suggestion] = suggestions;
    if (thread === undefined || suggestion === undefined || suggestions.length !== 1 || thread.outdated || thread.side !== 'RIGHT') {
      throw new Error('A suggestion is outdated or gone. Refresh and pick again.');
    }
    if (thread.path.startsWith('/') || thread.path.includes('\0') || thread.path.split('/').includes('..')) throw new Error('GitHub returned an invalid file path.');
    const list = edits.get(thread.path) ?? [];
    list.push({ startLine: thread.startLine, endLine: thread.endLine, code: suggestion.code });
    edits.set(thread.path, list);
  }
  return edits;
}

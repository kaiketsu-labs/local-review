import type * as vscode from 'vscode';
import type { ReviewStore } from './contracts.js';
import type { GitHubLink, Publication } from './pullRequestComments.js';

/** Where a document sits inside a review: its path, and whether it shows the original side at `revision`. */
export interface SessionLocation {
  readonly path: string;
  readonly original: boolean;
  readonly revision?: string;
}

/** One reviewable checkout, local changes or a PR worktree, with its own store and Claude connection. */
export interface ReviewSession {
  readonly key: string;
  /** Short prefix shown beside the session's threads; empty for local changes. */
  readonly label: string;
  readonly store: ReviewStore;
  resolveBase(): Promise<string | undefined>;
  locate(uri: vscode.Uri): SessionLocation | undefined;
  workingUri(path: string): vscode.Uri;
  originalUri(path: string, revision: string): vscode.Uri;
  /** What Claude is doing on a thread right now, if anything. */
  activity?(threadId: string): string | undefined;
  /** Where the thread was posted on the code host, if it was. */
  publication?(threadId: string): Publication | undefined;
  /** Let the user edit the thread's comment and post it to the code host. */
  publish?(threadId: string): Promise<void>;
  /** Post the thread's comment, as the user edited it on the review page, on the PR diff. */
  postToGitHub?(threadId: string, body: string, pending: boolean): Promise<void>;
  /** Remember the GitHub thread a local thread answers, so publishing replies inside it. */
  linkToGitHub?(threadId: string, link: GitHubLink): Promise<void>;
  /** The GitHub thread the local thread answers, if any; publishing replies inside it. */
  linkedGitHubThread?(threadId: string): string | undefined;
}

/** PR sessions that join the review UI next to local changes. */
export interface ReviewSessionSource {
  readonly sessions: readonly ReviewSession[];
  readonly onDidChange: vscode.Event<void>;
  /** Fires when a session's Claude moves to another step. */
  readonly onDidChangeActivity?: vscode.Event<unknown>;
}

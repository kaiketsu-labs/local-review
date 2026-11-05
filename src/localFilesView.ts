import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewStore } from './contracts.js';
import { fileTree, type FileFolder } from './fileTree.js';
import { listRepositoryFiles } from './localReview.js';

interface RepositoryFile { readonly path: string }
type Node = { readonly kind: 'folder'; readonly folder: FileFolder<RepositoryFile> } | { readonly kind: 'file'; readonly path: string };

/**
 * The Local view: every file of the workspace repository as a tree, with Git's change marks and the number of open comments.
 * Clicking a file shows it on the local review page.
 */
export class LocalFilesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #tree: Promise<FileFolder<RepositoryFile>> | undefined;

  constructor(private readonly root: string, private readonly store: Pick<ReviewStore, 'threads'>) {}

  /** List the repository's files again, after files were added or removed. */
  reload(): void {
    this.#tree = undefined;
    this.#changed.fire(undefined);
  }

  /** Redraw comment counts without listing the files again. */
  redraw(): void {
    this.#changed.fire(undefined);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    this.#tree ??= listRepositoryFiles(this.root).then((paths) => fileTree(paths.map((path) => ({ path }))));
    const folder = node === undefined ? await this.#tree : node.kind === 'folder' ? node.folder : undefined;
    if (folder === undefined) return [];
    return [
      ...folder.folders.map((child): Node => ({ kind: 'folder', folder: child })),
      ...folder.files.map((file): Node => ({ kind: 'file', path: file.path })),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const uri = vscode.Uri.file(join(this.root, node.kind === 'folder' ? node.folder.path : node.path));
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.folder.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.resourceUri = uri;
      item.iconPath = vscode.ThemeIcon.Folder;
      return item;
    }
    const item = new vscode.TreeItem(basename(node.path), vscode.TreeItemCollapsibleState.None);
    item.resourceUri = uri;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'pairReview.localFile';
    item.command = { command: 'pairReview.openLocalFile', title: 'Show on review page', arguments: [node.path] };
    const open = this.store.threads.filter((thread) => !thread.resolved && thread.anchor.path === node.path).length;
    if (open > 0) item.description = open === 1 ? '1 comment' : `${open} comments`;
    return item;
  }

  dispose(): void {
    this.#changed.dispose();
  }
}

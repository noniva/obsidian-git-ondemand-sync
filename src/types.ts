export type GitProvider = 'github' | 'gitlab';

export interface PluginSettings {
  provider: GitProvider;
  apiUrl: string;
  gitlabUrl?: string;
  projectId: string;
  branch: string;
  token: string;
  textAllowlist: string[];
  syncObsidianDir: boolean;
  attachmentFolder: string;
  autoSyncOnOpen: boolean;
  enableOnDesktop: boolean;
  enablePersistentImageCache: boolean;
  maxImageCacheMb: number;
  compressImagesOnUpload: boolean;
  maxUploadImageDimension: number;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  provider: 'github',
  apiUrl: 'https://api.github.com',
  projectId: '',
  branch: 'main',
  token: '',
  textAllowlist: ['.md', '.canvas', '.txt'],
  syncObsidianDir: false,
  attachmentFolder: 'attachments',
  autoSyncOnOpen: false,
  enableOnDesktop: false,
  enablePersistentImageCache: true,
  maxImageCacheMb: 50,
  compressImagesOnUpload: true,
  maxUploadImageDimension: 1920,
};

export interface SyncedFileEntry {
  blobSha: string;
  contentHash: string;
}

export interface SyncState {
  lastSyncedCommitSha: string | null;
  activeConflictBranch: string | null;
  files: Record<string, SyncedFileEntry>;
  remoteImagePaths: string[];
  conflictPushedHashes?: Record<string, string>;
  conflictDeletedPaths?: string[];
}

export interface RemoteTreeEntry {
  id: string;
  name: string;
  type: 'blob' | 'tree';
  path: string;
  mode: string;
}

export type GitLabTreeEntry = RemoteTreeEntry;

export interface RemoteCommitAction {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content?: string;
  encoding?: 'text' | 'base64';
}

export type GitLabCommitAction = RemoteCommitAction;

export interface CreateCommitParams {
  branch: string;
  commitMessage: string;
  actions: RemoteCommitAction[];
  startSha?: string;
}

export interface RemoteCompareEntry {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  blobSha?: string;
}

export interface RemoteGitClient {
  getBranchHead(branch: string): Promise<string>;
  getTreeRecursive(
    ref: string,
    onPage?: (info: { page: number; totalPages?: number; entries: number }) => void,
  ): Promise<RemoteTreeEntry[]>;
  compareCommits?(fromRef: string, toRef: string): Promise<RemoteCompareEntry[] | null>;
  getRawText(filePath: string, ref: string): Promise<string>;
  getRawTextsBatch?(filePaths: string[], ref: string): Promise<Map<string, string>>;
  getRawBinary(filePath: string, ref: string): Promise<ArrayBuffer>;
  createCommit(params: CreateCommitParams): Promise<string>;
}

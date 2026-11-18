export interface PluginSettings {
  gitlabUrl: string;
  projectId: string;
  branch: string;
  token: string;
  textAllowlist: string[];
  syncObsidianDir: boolean;
  attachmentFolder: string;
  autoSyncOnOpen: boolean;
  enableOnDesktop: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  gitlabUrl: 'https://gitlab.com',
  projectId: '',
  branch: 'main',
  token: '',
  textAllowlist: ['.md', '.canvas', '.txt'],
  syncObsidianDir: false,
  attachmentFolder: 'attachments',
  autoSyncOnOpen: false,
  enableOnDesktop: false,
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
}

export interface GitLabTreeEntry {
  id: string;
  name: string;
  type: 'blob' | 'tree';
  path: string;
  mode: string;
}

export interface GitLabCommitAction {
  action: 'create' | 'update' | 'delete';
  file_path: string;
  content?: string;
  encoding?: 'text' | 'base64';
}

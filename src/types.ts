export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}

export interface PersistedWorkingDirectoryConfig {
  channelId: string;
  userId?: string;
  directory: string;
  setAt: string; // ISO 8601
}
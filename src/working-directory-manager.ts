import { WorkingDirectoryConfig, PersistedWorkingDirectoryConfig } from './types.js';
import { Logger } from './logger.js';
import { config } from './config.js';
import * as path from 'path';
import * as fs from 'fs';

export class WorkingDirectoryManager {
  private configs: Map<string, WorkingDirectoryConfig> = new Map();
  private logger = new Logger('WorkingDirectoryManager');
  private persistPath: string;

  constructor() {
    this.persistPath = path.resolve(config.dataDirectory, 'working-directories.json');
    this.loadPersistedConfigs();
  }

  private loadPersistedConfigs(): void {
    try {
      if (!fs.existsSync(this.persistPath)) {
        this.logger.debug('No persisted working directory config found', { path: this.persistPath });
        return;
      }

      const raw = fs.readFileSync(this.persistPath, 'utf-8');
      const entries: PersistedWorkingDirectoryConfig[] = JSON.parse(raw);

      let loaded = 0;
      let skipped = 0;

      for (const entry of entries) {
        if (!fs.existsSync(entry.directory)) {
          this.logger.warn('Skipping persisted directory (no longer exists)', {
            channelId: entry.channelId,
            directory: entry.directory,
          });
          skipped++;
          continue;
        }

        const key = this.getConfigKey(entry.channelId, undefined, entry.userId);
        this.configs.set(key, {
          channelId: entry.channelId,
          userId: entry.userId,
          directory: entry.directory,
          setAt: new Date(entry.setAt),
        });
        loaded++;
      }

      this.logger.info('Loaded persisted working directory configs', { loaded, skipped });
    } catch (error) {
      this.logger.error('Failed to load persisted working directory configs', error);
    }
  }

  private savePersistedConfigs(): void {
    try {
      // Only persist non-thread configs (thread overrides are transient)
      const entries: PersistedWorkingDirectoryConfig[] = [];
      for (const wdConfig of this.configs.values()) {
        if (wdConfig.threadTs) continue;
        entries.push({
          channelId: wdConfig.channelId,
          userId: wdConfig.userId,
          directory: wdConfig.directory,
          setAt: wdConfig.setAt.toISOString(),
        });
      }

      const dir = path.dirname(this.persistPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify(entries, null, 2), 'utf-8');

      this.logger.debug('Saved persisted working directory configs', { count: entries.length });
    } catch (error) {
      this.logger.error('Failed to save persisted working directory configs', error);
    }
  }

  getConfigKey(channelId: string, threadTs?: string, userId?: string): string {
    if (threadTs) {
      return `${channelId}-${threadTs}`;
    }
    if (userId && channelId.startsWith('D')) { // Direct message
      return `${channelId}-${userId}`;
    }
    return channelId;
  }

  setWorkingDirectory(channelId: string, directory: string, threadTs?: string, userId?: string): { success: boolean; resolvedPath?: string; error?: string } {
    try {
      const resolvedPath = this.resolveDirectory(directory);

      if (!resolvedPath) {
        return {
          success: false,
          error: `Directory not found: "${directory}"${config.baseDirectory ? ` (checked in base directory: ${config.baseDirectory})` : ''}`
        };
      }

      const stats = fs.statSync(resolvedPath);

      if (!stats.isDirectory()) {
        this.logger.warn('Path is not a directory', { directory: resolvedPath });
        return { success: false, error: 'Path is not a directory' };
      }

      const key = this.getConfigKey(channelId, threadTs, userId);
      const workingDirConfig: WorkingDirectoryConfig = {
        channelId,
        threadTs,
        userId,
        directory: resolvedPath,
        setAt: new Date(),
      };

      this.configs.set(key, workingDirConfig);
      this.logger.info('Working directory set', {
        key,
        directory: resolvedPath,
        originalInput: directory,
        isThread: !!threadTs,
        isDM: channelId.startsWith('D'),
      });

      this.savePersistedConfigs();

      return { success: true, resolvedPath };
    } catch (error) {
      this.logger.error('Failed to set working directory', error);
      return { success: false, error: 'Directory does not exist or is not accessible' };
    }
  }

  private resolveDirectory(directory: string): string | null {
    // If it's an absolute path, use it directly
    if (path.isAbsolute(directory)) {
      if (fs.existsSync(directory)) {
        return path.resolve(directory);
      }
      return null;
    }

    // If we have a base directory configured, try relative to base directory first
    if (config.baseDirectory) {
      const baseRelativePath = path.join(config.baseDirectory, directory);
      if (fs.existsSync(baseRelativePath)) {
        this.logger.debug('Found directory relative to base', {
          input: directory,
          baseDirectory: config.baseDirectory,
          resolved: baseRelativePath
        });
        return path.resolve(baseRelativePath);
      }
    }

    // Try relative to current working directory
    const cwdRelativePath = path.resolve(directory);
    if (fs.existsSync(cwdRelativePath)) {
      this.logger.debug('Found directory relative to cwd', {
        input: directory,
        resolved: cwdRelativePath
      });
      return cwdRelativePath;
    }

    return null;
  }

  getWorkingDirectory(channelId: string, threadTs?: string, userId?: string): string | undefined {
    // Priority: Thread > Channel/DM
    if (threadTs) {
      const threadKey = this.getConfigKey(channelId, threadTs);
      const threadConfig = this.configs.get(threadKey);
      if (threadConfig) {
        this.logger.debug('Using thread-specific working directory', {
          directory: threadConfig.directory,
          threadTs,
        });
        return threadConfig.directory;
      }
    }

    // Fall back to channel or DM config
    const channelKey = this.getConfigKey(channelId, undefined, userId);
    const channelConfig = this.configs.get(channelKey);
    if (channelConfig) {
      this.logger.debug('Using channel/DM working directory', {
        directory: channelConfig.directory,
        channelId,
      });
      return channelConfig.directory;
    }

    this.logger.debug('No working directory configured', { channelId, threadTs });
    return undefined;
  }

  getWorkingDirectoryWithSource(channelId: string, threadTs?: string, userId?: string): { directory: string; source: 'thread' | 'channel' | 'dm' } | undefined {
    if (threadTs) {
      const threadKey = this.getConfigKey(channelId, threadTs);
      const threadConfig = this.configs.get(threadKey);
      if (threadConfig) {
        return { directory: threadConfig.directory, source: 'thread' };
      }
    }

    const channelKey = this.getConfigKey(channelId, undefined, userId);
    const channelConfig = this.configs.get(channelKey);
    if (channelConfig) {
      const source = channelId.startsWith('D') ? 'dm' as const : 'channel' as const;
      return { directory: channelConfig.directory, source };
    }

    return undefined;
  }

  removeWorkingDirectory(channelId: string, threadTs?: string, userId?: string): boolean {
    const key = this.getConfigKey(channelId, threadTs, userId);
    const result = this.configs.delete(key);
    if (result) {
      this.logger.info('Working directory removed', { key });
      this.savePersistedConfigs();
    }
    return result;
  }

  listConfigurations(): WorkingDirectoryConfig[] {
    return Array.from(this.configs.values());
  }

  parseSetCommand(text: string): string | null {
    const cwdMatch = text.match(/^cwd\s+(.+)$/i);
    if (cwdMatch) {
      return cwdMatch[1].trim();
    }

    const setMatch = text.match(/^set\s+(?:cwd|dir|directory|working[- ]?directory)\s+(.+)$/i);
    if (setMatch) {
      return setMatch[1].trim();
    }

    return null;
  }

  isGetCommand(text: string): boolean {
    return /^(get\s+)?(cwd|dir|directory|working[- ]?directory)(\?)?$/i.test(text.trim());
  }

  parseResetCommand(text: string): boolean {
    return /^(reset|clear|remove)\s+(cwd|dir|directory|working[- ]?directory)$/i.test(text.trim());
  }

  formatDirectoryMessage(directory: string | undefined, context: string, source?: 'thread' | 'channel' | 'dm'): string {
    if (directory) {
      const sourceLabel = source === 'thread' ? ' (thread override)'
        : source === 'channel' ? ' (channel default)'
        : source === 'dm' ? ' (DM)'
        : '';
      let message = `Current working directory for ${context}${sourceLabel}: \`${directory}\``;
      if (config.baseDirectory) {
        message += `\n\nBase directory: \`${config.baseDirectory}\``;
        message += `\nYou can use relative paths like \`cwd project-name\` or absolute paths.`;
      }
      return message;
    }

    let message = `No working directory set for ${context}. Please set one using:`;
    if (config.baseDirectory) {
      message += `\n\`cwd project-name\` (relative to base directory)`;
      message += `\n\`cwd /absolute/path/to/directory\` (absolute path)`;
      message += `\n\nBase directory: \`${config.baseDirectory}\``;
    } else {
      message += `\n\`cwd /path/to/directory\` or \`set directory /path/to/directory\``;
    }
    return message;
  }

  getChannelWorkingDirectory(channelId: string): string | undefined {
    const key = this.getConfigKey(channelId);
    const cfg = this.configs.get(key);
    return cfg?.directory;
  }

  hasChannelWorkingDirectory(channelId: string): boolean {
    return !!this.getChannelWorkingDirectory(channelId);
  }

  formatChannelSetupMessage(channelId: string, channelName: string): string {
    const hasBaseDir = !!config.baseDirectory;

    let message = `🏠 *Channel Working Directory Setup*\n\n`;
    message += `Please set the default working directory for #${channelName}:\n\n`;

    if (hasBaseDir) {
      message += `*Options:*\n`;
      message += `• \`cwd project-name\` (relative to: \`${config.baseDirectory}\`)\n`;
      message += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
    } else {
      message += `*Usage:*\n`;
      message += `• \`cwd /path/to/project\`\n`;
      message += `• \`set directory /path/to/project\`\n\n`;
    }

    message += `This becomes the default for all conversations in this channel.\n`;
    message += `Individual threads can override this by mentioning me with a different \`cwd\` command.`;

    return message;
  }
}

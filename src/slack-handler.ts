import * as os from 'os';
import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler.js';
import { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from './logger.js';
import { WorkingDirectoryManager } from './working-directory-manager.js';
import { FileHandler, ProcessedFile, FileProcessingDiagnostic } from './file-handler.js';
import { TodoManager, Todo } from './todo-manager.js';
import { McpManager } from './mcp-manager.js';
import { PermissionHandler } from './permission-handler.js';
import { config } from './config.js';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

interface QueuedMessage {
  event: MessageEvent;
  say: any;
  processedFiles: ProcessedFile[];
}

interface MrkdwnBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private permissionHandler: PermissionHandler;

  // Message tracking
  private todoMessages: Map<string, string> = new Map();
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map();
  private currentReactions: Map<string, string> = new Map();
  private botUserId: string | null = null;

  // Concurrency control
  private activeSessions: Set<string> = new Set();
  private sessionQueues: Map<string, QueuedMessage[]> = new Map();
  private activeControllers: Map<string, AbortController> = new Map();
  private activeConcurrency: number = 0;
  private maxConcurrency: number;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager, permissionHandler: PermissionHandler) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.permissionHandler = permissionHandler;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.maxConcurrency = config.maxConcurrency;
  }

  private buildMrkdwnMessage(text: string): { text: string; blocks: MrkdwnBlock[] } {
    const BLOCK_TEXT_LIMIT = 3000;
    const blocks: MrkdwnBlock[] = [];

    if (text.length <= BLOCK_TEXT_LIMIT) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
    } else {
      const chunks = this.splitTextForBlocks(text, BLOCK_TEXT_LIMIT);
      for (const chunk of chunks) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
      }
    }
    return { text, blocks };
  }

  private splitTextForBlocks(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to split at paragraph boundary
      let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
      if (splitIndex <= 0) {
        // Try newline boundary
        splitIndex = remaining.lastIndexOf('\n', maxLength);
      }
      if (splitIndex <= 0) {
        // Try space boundary
        splitIndex = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitIndex <= 0) {
        // Hard cut
        splitIndex = maxLength;
      }

      chunks.push(remaining.substring(0, splitIndex));
      remaining = remaining.substring(splitIndex).trimStart();
    }

    return chunks;
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', {
        count: files.length,
        fileDetails: files.map(f => ({
          id: f.id,
          name: f.name,
          mimetype: f.mimetype,
          filetype: f.filetype,
          size: f.size,
          hasUrlPrivate: !!f.url_private,
          hasUrlPrivateDownload: !!f.url_private_download,
        })),
      });

      const { processed, diagnostics } = await this.fileHandler.downloadAndProcessFiles(files);
      processedFiles = processed;

      if (processedFiles.length > 0) {
        const fileMsg = `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`;
        await say({
          ...this.buildMrkdwnMessage(fileMsg),
          thread_ts: thread_ts || ts,
        });
      }

      // Show diagnostics in Slack if there were issues
      const diagMsg = this.fileHandler.formatDiagnostics(diagnostics);
      if (diagMsg) {
        await say({
          ...this.buildMrkdwnMessage(diagMsg),
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        const msg = `✅ Working directory set for ${context}: \`${result.resolvedPath}\``;
        await say({
          ...this.buildMrkdwnMessage(msg),
          thread_ts: thread_ts || ts,
        });
      } else {
        const msg = `❌ ${result.error}`;
        await say({
          ...this.buildMrkdwnMessage(msg),
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.getWorkingDirectoryWithSource(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      const msg = this.workingDirManager.formatDirectoryMessage(result?.directory, context, result?.source);

      await say({
        ...this.buildMrkdwnMessage(msg),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is a reset directory command (only if there's text)
    if (text && this.workingDirManager.parseResetCommand(text)) {
      const isDM = channel.startsWith('D');

      if (thread_ts) {
        // Reset thread override only
        const removed = this.workingDirManager.removeWorkingDirectory(channel, thread_ts);
        if (removed) {
          const channelDir = this.workingDirManager.getChannelWorkingDirectory(channel);
          let msg = `✅ Thread working directory override removed.`;
          if (channelDir) {
            msg += `\nFalling back to channel default: \`${channelDir}\``;
          }
          await say({
            ...this.buildMrkdwnMessage(msg),
            thread_ts: thread_ts || ts,
          });
        } else {
          await say({
            ...this.buildMrkdwnMessage(`ℹ️ No thread-specific working directory was set.`),
            thread_ts: thread_ts || ts,
          });
        }
      } else {
        // Reset channel/DM config
        const removed = this.workingDirManager.removeWorkingDirectory(
          channel,
          undefined,
          isDM ? user : undefined
        );
        if (removed) {
          const context = isDM ? 'this conversation' : 'this channel';
          await say({
            ...this.buildMrkdwnMessage(`✅ Working directory removed for ${context}.`),
            thread_ts: thread_ts || ts,
          });
        } else {
          await say({
            ...this.buildMrkdwnMessage(`ℹ️ No working directory was set.`),
            thread_ts: thread_ts || ts,
          });
        }
      }
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        ...this.buildMrkdwnMessage(this.mcpManager.formatMcpInfo()),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        const msg = `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`;
        await say({
          ...this.buildMrkdwnMessage(msg),
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          ...this.buildMrkdwnMessage(`❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`),
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a debug command
    if (text && this.isDebugCommand(text)) {
      await this.handleDebugCommand(text, channel, thread_ts || ts, say);
      return;
    }

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;

      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }

      await say({
        ...this.buildMrkdwnMessage(errorMessage),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // === Concurrency / Queue check ===
    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);

    if (this.activeSessions.has(sessionKey)) {
      // Same session is already processing — queue this message
      this.enqueueMessage(sessionKey, { event, say, processedFiles });
      await say({
        ...this.buildMrkdwnMessage('📥 *Queued* — your message will be processed after the current task completes.'),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    if (this.activeConcurrency >= this.maxConcurrency) {
      // Global capacity reached — queue this message
      this.enqueueMessage(sessionKey, { event, say, processedFiles });
      await say({
        ...this.buildMrkdwnMessage('📥 *Queued* — the server is busy. Your message will be processed shortly.'),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Process immediately
    await this.processClaudeQuery(event, say, sessionKey, processedFiles);
  }

  private enqueueMessage(sessionKey: string, message: QueuedMessage) {
    const queue = this.sessionQueues.get(sessionKey) || [];
    queue.push(message);
    this.sessionQueues.set(sessionKey, queue);
    this.logger.info('Message queued', { sessionKey, queueLength: queue.length });
  }

  private processNextInQueue() {
    // Look for any session that has queued messages and is not currently active
    for (const [sessionKey, queue] of this.sessionQueues) {
      if (!this.activeSessions.has(sessionKey) && queue.length > 0) {
        if (this.activeConcurrency >= this.maxConcurrency) return;

        const next = queue.shift()!;
        if (queue.length === 0) this.sessionQueues.delete(sessionKey);

        this.logger.info('Processing next queued message', { sessionKey, remaining: queue.length });
        // Use setImmediate to avoid deep recursion from chained completions
        setImmediate(() => {
          this.processClaudeQuery(next.event, next.say, sessionKey, next.processedFiles);
        });
        return;
      }
    }
  }

  private async processClaudeQuery(
    event: MessageEvent,
    say: any,
    sessionKey: string,
    processedFiles: ProcessedFile[],
  ) {
    const { user, channel, thread_ts, ts, text } = event;

    this.activeSessions.add(sessionKey);
    this.activeConcurrency++;

    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });

    // Fresh working directory lookup (may have changed while queued)
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined,
    );

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Relocate uploaded files into the working directory so the SDK can access them
      if (processedFiles.length > 0 && workingDirectory) {
        this.fileHandler.relocateToWorkingDirectory(processedFiles, workingDirectory);
      }

      // Prepare the prompt with file attachments
      const finalPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      this.logger.info('Sending query to Claude Code SDK', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        ...this.buildMrkdwnMessage('🤔 *Thinking...*'),
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Add thinking reaction to original message
      await this.updateMessageReaction(sessionKey, '🤔');

      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts,
        user,
        workingDirectory,
      };

      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory!, slackContext)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                ...this.buildMrkdwnMessage('⚙️ *Working...*'),
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, '⚙️');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) {
              await say({
                ...this.buildMrkdwnMessage(toolContent),
                thread_ts: thread_ts || ts,
              });
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);

              const formatted = this.formatMessage(content, false);
              await say({
                ...this.buildMrkdwnMessage(formatted),
                thread_ts: thread_ts || ts,
              });
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });

          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                ...this.buildMrkdwnMessage(formatted),
                thread_ts: thread_ts || ts,
              });
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          ...this.buildMrkdwnMessage('✅ *Task completed*'),
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, '✅');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);

        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            ...this.buildMrkdwnMessage('❌ *Error occurred*'),
          });
        }

        await this.updateMessageReaction(sessionKey, '❌');

        await say({
          ...this.buildMrkdwnMessage(`Error: ${error.message || 'Something went wrong'}`),
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });

        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            ...this.buildMrkdwnMessage('⏹️ *Cancelled*'),
          });
        }

        await this.updateMessageReaction(sessionKey, '⏹️');
      }
    } finally {
      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }

      // Release concurrency slot
      this.activeControllers.delete(sessionKey);
      this.activeSessions.delete(sessionKey);
      this.activeConcurrency--;

      // Process next queued message
      this.processNextInQueue();

      // Clean up session tracking after delay
      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000);
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;

        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }

    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];

    let result = `📝 *Editing \`${filePath}\`*\n`;

    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }

    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);

    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    return '';
  }

  private async handleTodoUpdate(
    input: any,
    sessionKey: string,
    sessionId: string | undefined,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);

    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      this.todoManager.updateTodos(sessionId, newTodos);

      const todoList = this.todoManager.formatTodoList(newTodos);

      const existingTodoMessageTs = this.todoMessages.get(sessionKey);

      if (existingTodoMessageTs) {
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            ...this.buildMrkdwnMessage(todoList),
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        const msg = `🔄 *Task Update:*\n${statusChange}`;
        await say({
          ...this.buildMrkdwnMessage(msg),
          thread_ts: threadTs,
        });
      }

      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string,
    channel: string,
    threadTs: string,
    sessionKey: string,
    say: any
  ): Promise<void> {
    const result = await say({
      ...this.buildMrkdwnMessage(todoList),
      thread_ts: threadTs,
    });

    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', {
            sessionKey,
            emoji: currentEmoji,
            error: (error as any).message
          });
        }
      }

      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', {
        sessionKey,
        emoji,
        previousEmoji: currentEmoji,
        channel: originalMessage.channel,
        ts: originalMessage.ts
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = '✅';
    } else if (inProgress > 0) {
      emoji = '🔄';
    } else {
      emoji = '📋';
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isDebugCommand(text: string): boolean {
    return /^debug(\s+.*)?$/i.test(text.trim());
  }

  private async handleDebugCommand(text: string, channel: string, threadTs: string, say: any): Promise<void> {
    const subCommand = text.trim().replace(/^debug\s*/i, '').trim().toLowerCase();

    let msg = '';

    if (subCommand === 'files' || subCommand === 'file') {
      msg = this.getFileDebugInfo();
    } else if (subCommand === 'config' || subCommand === 'env') {
      msg = this.getConfigDebugInfo();
    } else if (subCommand === 'sessions') {
      msg = this.getSessionDebugInfo();
    } else if (subCommand === 'permissions' || subCommand === 'perms') {
      msg = this.getPermissionDebugInfo();
    } else if (subCommand === 'permissions reset' || subCommand === 'perms reset') {
      this.permissionHandler.clearApprovals();
      msg = '✅ All remembered tool approvals have been cleared. Tools will require permission again on next use.';
    } else {
      // Show all debug info
      msg = '*🔍 Debug Information*\n\n';
      msg += this.getConfigDebugInfo();
      msg += '\n\n';
      msg += this.getSessionDebugInfo();
      msg += '\n\n';
      msg += this.getPermissionDebugInfo();
      msg += '\n\n';
      msg += this.getFileDebugInfo();
      msg += '\n\n';
      msg += '*Available debug subcommands:*\n';
      msg += '• `debug` — Show all debug info\n';
      msg += '• `debug config` — Show configuration\n';
      msg += '• `debug sessions` — Show active sessions\n';
      msg += '• `debug permissions` — Show remembered approvals\n';
      msg += '• `debug permissions reset` — Clear all remembered approvals\n';
      msg += '• `debug files` — Show file handling info\n';
    }

    await say({
      ...this.buildMrkdwnMessage(msg),
      thread_ts: threadTs,
    });
  }

  private getConfigDebugInfo(): string {
    let msg = '*⚙️ Configuration:*\n';
    msg += `• Log Level: \`${config.logLevel}\`\n`;
    msg += `• Debug Mode: \`${config.debug}\`\n`;
    msg += `• Log File: \`${config.logFile || '(none)'}\`\n`;
    msg += `• Base Directory: \`${config.baseDirectory || '(not set)'}\`\n`;
    msg += `• Max Concurrency: \`${config.maxConcurrency}\`\n`;
    msg += `• Bot Token: \`${config.slack.botToken ? config.slack.botToken.substring(0, 10) + '...' : '(missing)'}\`\n`;
    msg += `• Platform: \`${process.platform}\`\n`;
    msg += `• Node.js: \`${process.version}\`\n`;
    msg += `• Uptime: \`${Math.floor(process.uptime())}s\`\n`;
    msg += `• Memory: \`${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB\`\n`;
    return msg;
  }

  private getSessionDebugInfo(): string {
    let msg = '*📡 Sessions:*\n';
    msg += `• Active sessions: \`${this.activeSessions.size}\`\n`;
    msg += `• Active concurrency: \`${this.activeConcurrency} / ${this.maxConcurrency}\`\n`;
    msg += `• Queued sessions: \`${this.sessionQueues.size}\`\n`;
    const totalQueued = Array.from(this.sessionQueues.values()).reduce((sum, q) => sum + q.length, 0);
    msg += `• Total queued messages: \`${totalQueued}\`\n`;
    msg += `• Active controllers: \`${this.activeControllers.size}\`\n`;
    msg += `• Todo messages tracked: \`${this.todoMessages.size}\`\n`;
    return msg;
  }

  private getPermissionDebugInfo(): string {
    const approvals = this.permissionHandler.getApprovalSummary();
    let msg = '*🔐 Remembered Approvals:*\n';
    if (approvals.length === 0) {
      msg += '_No tools have been approved yet. Each tool will prompt for permission on first use per directory._\n';
    } else {
      for (const { directory, tools } of approvals) {
        msg += `• \`${directory}\`: ${tools.map(t => `\`${t}\``).join(', ')}\n`;
      }
      msg += '\n_Use `debug permissions reset` to clear all approvals._\n';
    }
    return msg;
  }

  private getFileDebugInfo(): string {
    let msg = '*📎 File Handling:*\n';
    msg += `• Supported types:\n`;
    for (const type of this.fileHandler.getSupportedFileTypes()) {
      msg += `  - ${type}\n`;
    }
    msg += `• Temp directory: \`${os.tmpdir()}\`\n`;
    msg += `• Max file size: \`50MB\`\n`;
    msg += '\n_Upload a file with your message to test file processing. Diagnostics will be shown if any issues occur._\n';
    return msg;
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';

      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;

      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }

      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        ...this.buildMrkdwnMessage(welcomeMessage),
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Step 1: Preserve code blocks (replace with placeholders to avoid modifying their content)
    const codeBlocks: string[] = [];
    let formatted = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (match) => {
      const index = codeBlocks.length;
      // Strip language identifier for Slack (```typescript → ```)
      const cleaned = match.replace(/```\w+\n/, '```\n');
      codeBlocks.push(cleaned);
      return `\x00CB${index}\x00`;
    });

    // Step 2: Preserve inline code
    const inlineCodes: string[] = [];
    formatted = formatted.replace(/`([^`]+)`/g, (match) => {
      const index = inlineCodes.length;
      inlineCodes.push(match);
      return `\x00IC${index}\x00`;
    });

    // Step 3: Convert Markdown headings to Slack bold
    formatted = formatted.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

    // Step 4: Convert horizontal rules to visual divider
    formatted = formatted.replace(/^[-*_]{3,}\s*$/gm, '━━━━━━━━━━━━━━━━━━━━');

    // Step 5: Convert Markdown tables to code blocks (before bold conversion)
    formatted = this.convertMarkdownTables(formatted);

    // Step 6: Convert **bold** and __bold__ to *bold* (Slack bold)
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '*$1*');
    formatted = formatted.replace(/__(.+?)__/g, '*$1*');

    // Step 7: Convert ~~strikethrough~~ to ~strikethrough~
    formatted = formatted.replace(/~~(.+?)~~/g, '~$1~');

    // Step 8: Convert Markdown links [text](url) to Slack links <url|text>
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

    // Step 9: Clean up excessive newlines
    formatted = formatted.replace(/\n{4,}/g, '\n\n\n');

    // Step 10: Restore inline code
    formatted = formatted.replace(/\x00IC(\d+)\x00/g, (_, index) => inlineCodes[parseInt(index)]);

    // Step 11: Restore code blocks
    formatted = formatted.replace(/\x00CB(\d+)\x00/g, (_, index) => codeBlocks[parseInt(index)]);

    return formatted;
  }

  private convertMarkdownTables(text: string): string {
    // Match consecutive lines that form a Markdown table (lines starting and ending with |)
    return text.replace(
      /((?:^\|.+\|$\n?){2,})/gm,
      (tableBlock) => {
        const lines = tableBlock.trim().split('\n');
        // Filter out separator rows (e.g., |------|------|)
        const dataLines = lines.filter(line => !line.match(/^\|[\s\-:|]+\|$/));
        if (dataLines.length === 0) return tableBlock;
        return '```\n' + dataLines.join('\n') + '\n```';
      }
    );
  }

  setupEventHandlers() {
    // Handle direct messages (including file uploads)
    this.app.message(async ({ message, say }) => {
      this.logger.debug('Raw message event received', {
        type: (message as any).type,
        subtype: (message as any).subtype,
        user: (message as any).user,
        channel: (message as any).channel,
        hasFiles: !!(message as any).files,
        fileCount: (message as any).files?.length || 0,
        hasText: !!(message as any).text,
        textPreview: (message as any).text?.substring(0, 100),
        // Log all top-level keys for unknown event shapes
        eventKeys: Object.keys(message),
      });

      if ('user' in message && (message.subtype === undefined || message.subtype === 'file_share')) {
        this.logger.info('Handling direct message event', {
          subtype: message.subtype || 'text',
          hasFiles: !!(message as any).files,
          fileCount: (message as any).files?.length || 0,
        });
        await this.handleMessage(message as MessageEvent, say);
      } else {
        this.logger.debug('Skipping message event', {
          reason: !('user' in message) ? 'no user field' : `unhandled subtype: ${(message as any).subtype}`,
          subtype: (message as any).subtype,
        });
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.debug('Raw app_mention event received', {
        user: event.user,
        channel: event.channel,
        hasFiles: !!(event as any).files,
        fileCount: (event as any).files?.length || 0,
        textPreview: event.text?.substring(0, 100),
        eventKeys: Object.keys(event),
      });

      this.logger.info('Handling app mention event', {
        hasFiles: !!(event as any).files,
        fileCount: (event as any).files?.length || 0,
      });
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });

      this.permissionHandler.resolveApproval(approvalId, true);

      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });

      this.permissionHandler.resolveApproval(approvalId, false);

      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied'
      });
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000);
  }
}

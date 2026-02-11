import http from 'http';
import * as path from 'path';
import { App } from '@slack/bolt';
import { Logger } from './logger.js';

interface PendingPermission {
  httpRes: http.ServerResponse;
  channel: string;
  threadTs?: string;
  user?: string;
  toolName: string;
  input: any;
  workingDirectory?: string;
  messageTs?: string;
}

/**
 * Extracts the file path that a tool operates on, if applicable.
 */
function extractToolTargetPath(toolName: string, input: any): string | undefined {
  // File-based tools
  if (input?.file_path) return input.file_path;
  if (input?.path) return input.path;
  // Bash — no reliable single path, treated at directory level
  return undefined;
}

/**
 * Checks whether a target path is inside the given working directory.
 */
function isPathWithinDirectory(targetPath: string, directory: string): boolean {
  const resolved = path.resolve(targetPath);
  const dir = path.resolve(directory);
  return resolved === dir || resolved.startsWith(dir + path.sep);
}

export class PermissionHandler {
  private server: http.Server;
  private port: number = 0;
  private pending: Map<string, PendingPermission> = new Map();
  private app: App;
  private logger = new Logger('PermissionHandler');

  /**
   * Remembered approvals: workingDirectory -> Set of tool names approved for that directory.
   * Once a user approves a tool for a directory, subsequent uses of that tool
   * within the same directory are auto-approved without prompting.
   */
  private approvedTools: Map<string, Set<string>> = new Map();

  constructor(app: App) {
    this.app = app;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        this.logger.info(`Permission bridge listening on port ${this.port}`);
        resolve(this.port);
      });
      this.server.on('error', reject);
    });
  }

  getPort(): number {
    return this.port;
  }

  /** Get a summary of currently remembered approvals (for debug command) */
  getApprovalSummary(): { directory: string; tools: string[] }[] {
    const result: { directory: string; tools: string[] }[] = [];
    for (const [dir, tools] of this.approvedTools) {
      result.push({ directory: dir, tools: Array.from(tools) });
    }
    return result;
  }

  /** Clear all remembered approvals */
  clearApprovals(): void {
    this.approvedTools.clear();
    this.logger.info('All remembered approvals cleared');
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method === 'POST' && req.url === '/permission-request') {
      let body = '';
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          this.handlePermissionRequest(data, res);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ behavior: 'deny', message: 'Invalid request' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  private async handlePermissionRequest(
    data: {
      tool_name: string;
      input: any;
      channel: string;
      thread_ts?: string;
      user?: string;
      working_directory?: string;
    },
    res: http.ServerResponse,
  ) {
    const { tool_name, input, channel, thread_ts, user, working_directory } = data;

    // --- Auto-approval check ---
    if (working_directory && this.isAutoApproved(tool_name, input, working_directory)) {
      this.logger.info('Auto-approved tool (previously approved for directory)', {
        tool_name,
        working_directory,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ behavior: 'allow', message: 'Auto-approved (previously approved for this directory)' }));
      return;
    }

    // --- Prompt the user ---
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.pending.set(approvalId, {
      httpRes: res,
      channel,
      threadTs: thread_ts,
      user,
      toolName: tool_name,
      input,
      workingDirectory: working_directory,
    });

    const inputPreview = JSON.stringify(input, null, 2);
    const dirLabel = working_directory ? `\nDirectory: \`${working_directory}\`` : '';
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔐 *Permission Request*\n\nClaude wants to use the tool: \`${tool_name}\`${dirLabel}\n\n*Tool Parameters:*\n\`\`\`json\n${inputPreview}\n\`\`\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve' },
            style: 'primary',
            action_id: 'approve_tool',
            value: approvalId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Deny' },
            style: 'danger',
            action_id: 'deny_tool',
            value: approvalId,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Requested by: <@${user}> | Tool: ${tool_name}${working_directory ? ` | Dir: ${working_directory}` : ''}`,
          },
        ],
      },
    ];

    try {
      const result = await this.app.client.chat.postMessage({
        channel: channel || 'general',
        thread_ts,
        blocks,
        text: `Permission request for ${tool_name}`,
      });

      const pending = this.pending.get(approvalId);
      if (pending && result.ts) {
        pending.messageTs = result.ts;
      }
    } catch (error) {
      this.logger.error('Failed to post permission request to Slack', error);
      this.respond(approvalId, false, 'Failed to send Slack message');
    }

    // Timeout after 5 minutes
    setTimeout(() => {
      if (this.pending.has(approvalId)) {
        this.logger.warn('Permission request timed out', { approvalId });
        this.respond(approvalId, false, 'Permission request timed out');
      }
    }, 5 * 60 * 1000);
  }

  /**
   * Check if this tool + directory combination was previously approved.
   */
  private isAutoApproved(toolName: string, input: any, workingDirectory: string): boolean {
    const approved = this.approvedTools.get(workingDirectory);
    if (!approved || !approved.has(toolName)) {
      return false;
    }

    // For file-based tools, verify the target path is within the working directory
    const targetPath = extractToolTargetPath(toolName, input);
    if (targetPath) {
      const within = isPathWithinDirectory(targetPath, workingDirectory);
      if (!within) {
        this.logger.warn('Auto-approval denied: target path is outside working directory', {
          toolName,
          targetPath,
          workingDirectory,
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Remember that a tool is approved for a working directory.
   */
  private rememberApproval(toolName: string, workingDirectory: string): void {
    let tools = this.approvedTools.get(workingDirectory);
    if (!tools) {
      tools = new Set();
      this.approvedTools.set(workingDirectory, tools);
    }
    tools.add(toolName);
    this.logger.info('Remembered tool approval for directory', {
      toolName,
      workingDirectory,
      allApprovedTools: Array.from(tools),
    });
  }

  resolveApproval(approvalId: string, approved: boolean) {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    // Remember approval for future auto-approval
    if (approved && pending.workingDirectory) {
      this.rememberApproval(pending.toolName, pending.workingDirectory);
    }

    // Update the Slack message to show result
    if (pending.messageTs) {
      const inputPreview = JSON.stringify(pending.input, null, 2);
      const rememberNote = approved && pending.workingDirectory
        ? `\n_This tool will be auto-approved for \`${pending.workingDirectory}\` from now on._`
        : '';
      this.app.client.chat.update({
        channel: pending.channel,
        ts: pending.messageTs,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔐 *Permission Request* — ${approved ? '✅ Approved' : '❌ Denied'}\n\nTool: \`${pending.toolName}\`\n\n*Tool Parameters:*\n\`\`\`json\n${inputPreview}\n\`\`\`${rememberNote}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `${approved ? 'Approved' : 'Denied'} by user | Tool: ${pending.toolName}`,
              },
            ],
          },
        ],
        text: `Permission ${approved ? 'approved' : 'denied'} for ${pending.toolName}`,
      }).catch((err) => {
        this.logger.warn('Failed to update permission message', err);
      });
    }

    this.respond(approvalId, approved, approved ? 'Approved by user' : 'Denied by user');
  }

  private respond(approvalId: string, approved: boolean, message: string) {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    this.pending.delete(approvalId);

    const response = {
      behavior: approved ? 'allow' : 'deny',
      message,
    };

    try {
      pending.httpRes.writeHead(200, { 'Content-Type': 'application/json' });
      pending.httpRes.end(JSON.stringify(response));
    } catch (err) {
      this.logger.warn('Failed to respond to permission request HTTP', err);
    }
  }

  async stop() {
    for (const [approvalId] of this.pending) {
      this.respond(approvalId, false, 'Server shutting down');
    }
    return new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}

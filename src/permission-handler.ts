import http from 'http';
import { App } from '@slack/bolt';
import { Logger } from './logger.js';

interface PendingPermission {
  httpRes: http.ServerResponse;
  channel: string;
  threadTs?: string;
  user?: string;
  toolName: string;
  input: any;
  messageTs?: string;
}

export class PermissionHandler {
  private server: http.Server;
  private port: number = 0;
  private pending: Map<string, PendingPermission> = new Map();
  private app: App;
  private logger = new Logger('PermissionHandler');

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
    data: { tool_name: string; input: any; channel: string; thread_ts?: string; user?: string },
    res: http.ServerResponse,
  ) {
    const { tool_name, input, channel, thread_ts, user } = data;
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.pending.set(approvalId, {
      httpRes: res,
      channel,
      threadTs: thread_ts,
      user,
      toolName: tool_name,
      input,
    });

    const inputPreview = JSON.stringify(input, null, 2);
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔐 *Permission Request*\n\nClaude wants to use the tool: \`${tool_name}\`\n\n*Tool Parameters:*\n\`\`\`json\n${inputPreview}\n\`\`\``,
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
            text: `Requested by: <@${user}> | Tool: ${tool_name}`,
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

  resolveApproval(approvalId: string, approved: boolean) {
    const pending = this.pending.get(approvalId);
    if (!pending) return;

    // Update the Slack message to show result
    if (pending.messageTs) {
      const inputPreview = JSON.stringify(pending.input, null, 2);
      this.app.client.chat.update({
        channel: pending.channel,
        ts: pending.messageTs,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔐 *Permission Request* — ${approved ? '✅ Approved' : '❌ Denied'}\n\nTool: \`${pending.toolName}\`\n\n*Tool Parameters:*\n\`\`\`json\n${inputPreview}\n\`\`\``,
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

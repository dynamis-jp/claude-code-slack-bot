#!/usr/bin/env node

/**
 * Permission MCP Server (child process)
 *
 * Runs as a child process spawned by the Claude Code SDK.
 * Relays permission requests to the main process via HTTP
 * (the PermissionHandler's bridge server).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "permission-prompt", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "permission_prompt",
      description: "Request user permission for tool execution via Slack",
      inputSchema: {
        type: "object" as const,
        properties: {
          tool_name: {
            type: "string",
            description: "Name of the tool requesting permission",
          },
          input: {
            type: "object",
            description: "Input parameters for the tool",
          },
        },
        required: ["tool_name", "input"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "permission_prompt") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { tool_name, input } = request.params.arguments as {
    tool_name: string;
    input: any;
  };

  const bridgePort = process.env.PERMISSION_BRIDGE_PORT;
  const slackContext = JSON.parse(process.env.SLACK_CONTEXT || "{}");

  if (!bridgePort) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            behavior: "deny",
            message: "No permission bridge configured",
          }),
        },
      ],
    };
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${bridgePort}/permission-request`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tool_name,
          input,
          channel: slackContext.channel,
          thread_ts: slackContext.threadTs,
          user: slackContext.user,
        }),
      },
    );

    const result = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            behavior: "deny",
            message: `Error communicating with permission bridge: ${error.message}`,
          }),
        },
      ],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

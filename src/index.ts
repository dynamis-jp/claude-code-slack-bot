import { App } from '@slack/bolt';
import { config, validateConfig } from './config.js';
import { ClaudeHandler } from './claude-handler.js';
import { SlackHandler } from './slack-handler.js';
import { McpManager } from './mcp-manager.js';
import { PermissionHandler } from './permission-handler.js';
import { Logger } from './logger.js';

const logger = new Logger('Main');

async function start() {
  try {
    // Validate configuration
    validateConfig();

    logger.info('Starting Claude Code Slack bot', {
      debug: config.debug,
      useBedrock: config.claude.useBedrock,
      useVertex: config.claude.useVertex,
    });

    // Initialize Slack app
    const app = new App({
      token: config.slack.botToken,
      signingSecret: config.slack.signingSecret,
      socketMode: true,
      appToken: config.slack.appToken,
    });

    // Initialize MCP manager
    const mcpManager = new McpManager();
    const mcpConfig = mcpManager.loadConfiguration();

    // Initialize permission handler (HTTP bridge for child MCP processes)
    const permissionHandler = new PermissionHandler(app);
    const permissionBridgePort = await permissionHandler.start();

    // Initialize handlers
    const claudeHandler = new ClaudeHandler(mcpManager, permissionBridgePort);
    const slackHandler = new SlackHandler(app, claudeHandler, mcpManager, permissionHandler);

    // Setup event handlers
    slackHandler.setupEventHandlers();

    // Start the app
    await app.start();
    logger.info('⚡️ Claude Code Slack bot is running!');
    logger.info('Configuration:', {
      usingBedrock: config.claude.useBedrock,
      usingVertex: config.claude.useVertex,
      usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
      debugMode: config.debug,
      baseDirectory: config.baseDirectory || 'not set',
      maxConcurrency: config.maxConcurrency,
      permissionBridgePort,
      mcpServers: mcpConfig ? Object.keys(mcpConfig.mcpServers).length : 0,
      mcpServerNames: mcpConfig ? Object.keys(mcpConfig.mcpServers) : [],
    });
  } catch (error) {
    logger.error('Failed to start the bot', error);
    process.exit(1);
  }
}

start();

import dotenv from 'dotenv';

dotenv.config();

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  dataDirectory: process.env.DATA_DIRECTORY || './data',
  maxConcurrency: parseInt(process.env.MAX_CONCURRENT_QUERIES || '5', 10),
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
  logLevel: (process.env.LOG_LEVEL || (process.env.DEBUG === 'true' ? 'debug' : 'info')).toLowerCase() as 'trace' | 'debug' | 'info' | 'warn' | 'error',
  logFile: process.env.LOG_FILE || '',
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
  ];

  const missing = required.filter((key) => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
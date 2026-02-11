import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
import { Logger } from './logger.js';
import { config } from './config.js';

export interface ProcessedFile {
  path: string;
  name: string;
  mimetype: string;
  isImage: boolean;
  isText: boolean;
  isPdf: boolean;
  isDocx: boolean;
  isXlsx: boolean;
  size: number;
  tempPath?: string;
  convertedContent?: string;
}

export interface FileProcessingDiagnostic {
  fileName: string;
  status: 'success' | 'skipped' | 'error';
  steps: DiagnosticStep[];
  duration: number;
}

interface DiagnosticStep {
  step: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  timestamp: number;
}

export class FileHandler {
  private logger = new Logger('FileHandler');

  async downloadAndProcessFiles(files: any[]): Promise<{ processed: ProcessedFile[]; diagnostics: FileProcessingDiagnostic[] }> {
    const processedFiles: ProcessedFile[] = [];
    const diagnostics: FileProcessingDiagnostic[] = [];

    this.logger.info('Starting file processing batch', {
      totalFiles: files.length,
      files: files.map(f => ({
        id: f.id,
        name: f.name,
        mimetype: f.mimetype,
        filetype: f.filetype,
        size: f.size,
        mode: f.mode,
        hasUrlPrivate: !!f.url_private,
        hasUrlPrivateDownload: !!f.url_private_download,
        urlPrivatePrefix: f.url_private?.substring(0, 80),
        urlPrivateDownloadPrefix: f.url_private_download?.substring(0, 80),
      })),
    });

    for (const file of files) {
      const diag: FileProcessingDiagnostic = {
        fileName: file.name || '[unknown]',
        status: 'success',
        steps: [],
        duration: 0,
      };
      const startTime = Date.now();

      try {
        const processed = await this.downloadFile(file, diag);
        if (processed) {
          processedFiles.push(processed);
        } else {
          diag.status = 'skipped';
        }
      } catch (error) {
        diag.status = 'error';
        diag.steps.push({
          step: 'overall',
          status: 'error',
          detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          timestamp: Date.now(),
        });
        this.logger.error(`Failed to process file ${file.name}`, error);
      }

      diag.duration = Date.now() - startTime;
      diagnostics.push(diag);
    }

    this.logger.info('File processing batch completed', {
      total: files.length,
      succeeded: processedFiles.length,
      skipped: diagnostics.filter(d => d.status === 'skipped').length,
      failed: diagnostics.filter(d => d.status === 'error').length,
    });

    return { processed: processedFiles, diagnostics };
  }

  private async downloadFile(file: any, diag: FileProcessingDiagnostic): Promise<ProcessedFile | null> {
    // Step 1: Validate file metadata
    this.logger.debug('Processing file metadata', {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      filetype: file.filetype,
      size: file.size,
      mode: file.mode,
      prettyType: file.pretty_type,
      isExternal: file.is_external,
      externalType: file.external_type,
    });

    diag.steps.push({
      step: 'metadata',
      status: 'ok',
      detail: `id=${file.id} name=${file.name} mimetype=${file.mimetype} size=${file.size}`,
      timestamp: Date.now(),
    });

    // Check file size limit (50MB)
    if (file.size > 50 * 1024 * 1024) {
      this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
      diag.steps.push({ step: 'size_check', status: 'warn', detail: `File too large: ${file.size} bytes (limit: 50MB)`, timestamp: Date.now() });
      return null;
    }
    diag.steps.push({ step: 'size_check', status: 'ok', detail: `${file.size} bytes`, timestamp: Date.now() });

    // Step 2: Resolve download URL
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      this.logger.warn('No download URL available for file', {
        name: file.name,
        id: file.id,
        availableKeys: Object.keys(file).filter(k => k.startsWith('url')),
        allKeys: Object.keys(file),
      });
      diag.steps.push({ step: 'url_resolve', status: 'error', detail: `No download URL. Available URL keys: ${Object.keys(file).filter(k => k.startsWith('url')).join(', ')}`, timestamp: Date.now() });
      return null;
    }

    const urlSource = file.url_private_download ? 'url_private_download' : 'url_private';
    this.logger.debug('Download URL resolved', {
      name: file.name,
      urlSource,
      urlPrefix: downloadUrl.substring(0, 100),
      urlLength: downloadUrl.length,
    });
    diag.steps.push({ step: 'url_resolve', status: 'ok', detail: `Using ${urlSource}: ${downloadUrl.substring(0, 80)}...`, timestamp: Date.now() });

    try {
      // Step 3: HTTP download with manual redirect handling
      // NOTE: fetch() strips the Authorization header on cross-origin redirects
      // (Fetch API spec security feature). Slack's url_private_download redirects
      // to a CDN on a different origin, causing the auth header to be lost.
      // We use redirect: 'manual' to preserve the header across redirects.
      const fetchStart = Date.now();
      this.logger.debug('Starting HTTP download', { name: file.name, url: downloadUrl.substring(0, 80) });

      let currentUrl = downloadUrl;
      let redirectCount = 0;
      const MAX_REDIRECTS = 5;
      let response: Response;

      while (true) {
        response = await fetch(currentUrl, {
          headers: {
            'Authorization': `Bearer ${config.slack.botToken}`,
          },
          redirect: 'manual',
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) {
            this.logger.error('Redirect without Location header', {
              name: file.name,
              status: response.status,
              currentUrl: currentUrl.substring(0, 100),
            });
            diag.steps.push({
              step: 'http_download',
              status: 'error',
              detail: `Redirect (${response.status}) without Location header`,
              timestamp: Date.now(),
            });
            return null;
          }

          const previousUrl = currentUrl;
          currentUrl = new URL(location, currentUrl).href;
          redirectCount++;

          // Detect Slack login redirect (bot token missing files:read scope)
          if (currentUrl.includes('?redir=') || currentUrl.includes('/signin')) {
            this.logger.error('Slack redirected to login page — bot token likely missing files:read scope', {
              name: file.name,
              redirectUrl: currentUrl.substring(0, 120),
            });
            diag.steps.push({
              step: 'http_download',
              status: 'error',
              detail: `Slack redirected to login page instead of file CDN. The bot token is missing the "files:read" OAuth scope. Add it at https://api.slack.com/apps and reinstall the app.`,
              timestamp: Date.now(),
            });
            return null;
          }

          this.logger.debug('Following redirect (preserving auth header)', {
            name: file.name,
            redirectCount,
            from: previousUrl.substring(0, 80),
            to: currentUrl.substring(0, 80),
          });

          if (redirectCount > MAX_REDIRECTS) {
            this.logger.error('Too many redirects', { name: file.name, count: redirectCount });
            diag.steps.push({
              step: 'http_download',
              status: 'error',
              detail: `Too many redirects (${redirectCount})`,
              timestamp: Date.now(),
            });
            return null;
          }

          continue;
        }

        break;
      }

      const fetchDuration = Date.now() - fetchStart;

      this.logger.debug('HTTP response received', {
        name: file.name,
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type'),
        contentLength: response.headers.get('content-length'),
        redirectsFollowed: redirectCount,
        finalUrl: currentUrl.substring(0, 80),
        fetchDuration,
      });

      if (!response.ok) {
        const responseBody = await response.text().catch(() => '[could not read body]');
        this.logger.error('HTTP download failed', {
          name: file.name,
          status: response.status,
          statusText: response.statusText,
          responseBody: responseBody.substring(0, 500),
          headers: Object.fromEntries(response.headers.entries()),
        });
        diag.steps.push({
          step: 'http_download',
          status: 'error',
          detail: `HTTP ${response.status} ${response.statusText}. Body: ${responseBody.substring(0, 200)}`,
          timestamp: Date.now(),
        });
        return null;
      }

      // Check if Slack returned HTML instead of the actual file (auth failure fallback)
      const responseContentType = response.headers.get('content-type') || '';
      if (responseContentType.includes('text/html')) {
        const htmlBody = await response.text();
        const isSlackLoginPage = htmlBody.includes('slack-edge.com') || htmlBody.includes('<!DOCTYPE html>');
        this.logger.error('Slack returned HTML instead of file', {
          name: file.name,
          contentType: responseContentType,
          isSlackLoginPage,
          bodyPreview: htmlBody.substring(0, 300),
          redirectsFollowed: redirectCount,
        });
        diag.steps.push({
          step: 'http_download',
          status: 'error',
          detail: `Slack returned HTML instead of file content. Verify SLACK_BOT_TOKEN has files:read scope.`,
          timestamp: Date.now(),
        });
        return null;
      }

      diag.steps.push({
        step: 'http_download',
        status: 'ok',
        detail: `HTTP ${response.status} in ${fetchDuration}ms (${redirectCount} redirects), content-type=${responseContentType}, content-length=${response.headers.get('content-length')}`,
        timestamp: Date.now(),
      });

      // Step 4: Read response buffer
      const buffer = Buffer.from(await response.arrayBuffer());
      this.logger.debug('Response buffer created', {
        name: file.name,
        bufferSize: buffer.length,
        expectedSize: file.size,
        sizeMatch: buffer.length === file.size,
        firstBytes: buffer.slice(0, 16).toString('hex'),
      });

      if (buffer.length === 0) {
        this.logger.warn('Downloaded file is empty', { name: file.name });
        diag.steps.push({ step: 'buffer_read', status: 'warn', detail: 'Downloaded buffer is empty (0 bytes)', timestamp: Date.now() });
        return null;
      }

      if (buffer.length !== file.size) {
        this.logger.warn('Downloaded size differs from expected', {
          name: file.name,
          expected: file.size,
          actual: buffer.length,
        });
      }

      // Step 4b: Validate file content matches expected type (magic bytes check)
      const contentValidation = this.validateFileContent(buffer, file.mimetype, file.name);
      if (!contentValidation.valid) {
        this.logger.error('Downloaded content does not match expected file type', {
          name: file.name,
          expectedMimetype: file.mimetype,
          actualSignature: contentValidation.detectedType,
          reason: contentValidation.reason,
          firstBytesHex: buffer.slice(0, 16).toString('hex'),
          firstBytesAscii: buffer.slice(0, 50).toString('ascii').replace(/[^\x20-\x7E]/g, '.'),
        });
        diag.steps.push({
          step: 'content_validate',
          status: 'error',
          detail: `Content mismatch: expected ${file.mimetype} but got ${contentValidation.detectedType}. ${contentValidation.reason}`,
          timestamp: Date.now(),
        });
        return null;
      }

      diag.steps.push({
        step: 'content_validate',
        status: 'ok',
        detail: `Content verified: ${contentValidation.detectedType}`,
        timestamp: Date.now(),
      });

      diag.steps.push({
        step: 'buffer_read',
        status: 'ok',
        detail: `${buffer.length} bytes (expected ${file.size}). First bytes: ${buffer.slice(0, 8).toString('hex')}`,
        timestamp: Date.now(),
      });

      // Step 5: Write to temp file
      const tempDir = os.tmpdir();
      const ext = path.extname(file.name) || '';
      const tempPath = path.join(tempDir, `slack-file-${Date.now()}-${file.id}${ext}`);

      fs.writeFileSync(tempPath, buffer);

      // Verify written file
      const stat = fs.statSync(tempPath);
      this.logger.debug('Temp file written and verified', {
        name: file.name,
        tempPath,
        writtenSize: stat.size,
        bufferSize: buffer.length,
        sizeMatch: stat.size === buffer.length,
      });

      if (stat.size !== buffer.length) {
        this.logger.error('Temp file size mismatch after write', {
          tempPath,
          expected: buffer.length,
          actual: stat.size,
        });
      }

      diag.steps.push({
        step: 'temp_write',
        status: stat.size === buffer.length ? 'ok' : 'warn',
        detail: `Written to ${tempPath} (${stat.size} bytes)`,
        timestamp: Date.now(),
      });

      // Step 6: Classify file type
      const isImage = this.isImageFile(file.mimetype);
      const isText = this.isTextFile(file.mimetype, file.name);
      const isPdf = this.isPdfFile(file.mimetype, file.name);
      const isDocx = this.isDocxFile(file.mimetype, file.name);
      const isXlsx = this.isXlsxFile(file.mimetype, file.name);

      const classification = { isImage, isText, isPdf, isDocx, isXlsx };
      const classifiedAs = Object.entries(classification).filter(([, v]) => v).map(([k]) => k);

      this.logger.debug('File type classification', {
        name: file.name,
        mimetype: file.mimetype,
        extension: ext,
        classification,
        classifiedAs: classifiedAs.length > 0 ? classifiedAs : ['binary/unknown'],
      });

      diag.steps.push({
        step: 'classify',
        status: classifiedAs.length > 0 ? 'ok' : 'warn',
        detail: `mimetype=${file.mimetype} ext=${ext} => ${classifiedAs.length > 0 ? classifiedAs.join(', ') : 'binary/unknown'}`,
        timestamp: Date.now(),
      });

      const processed: ProcessedFile = {
        path: tempPath,
        name: file.name,
        mimetype: file.mimetype,
        isImage,
        isText,
        isPdf,
        isDocx,
        isXlsx,
        size: file.size,
        tempPath,
      };

      // Step 7: Convert if needed (DOCX/XLSX/PDF)
      if (isDocx) {
        this.logger.debug('Converting DOCX to text', { name: file.name });
        processed.convertedContent = await this.convertDocxToText(buffer);
        diag.steps.push({
          step: 'convert_docx',
          status: processed.convertedContent && !processed.convertedContent.startsWith('[') ? 'ok' : 'warn',
          detail: `Converted: ${processed.convertedContent?.length || 0} chars`,
          timestamp: Date.now(),
        });
      } else if (isXlsx) {
        this.logger.debug('Converting XLSX to text', { name: file.name });
        processed.convertedContent = this.convertXlsxToText(buffer);
        diag.steps.push({
          step: 'convert_xlsx',
          status: processed.convertedContent && !processed.convertedContent.startsWith('[') ? 'ok' : 'warn',
          detail: `Converted: ${processed.convertedContent?.length || 0} chars`,
          timestamp: Date.now(),
        });
      } else if (isPdf) {
        this.logger.debug('Extracting text from PDF', { name: file.name });
        processed.convertedContent = await this.convertPdfToText(buffer);
        diag.steps.push({
          step: 'convert_pdf',
          status: processed.convertedContent && !processed.convertedContent.startsWith('[') ? 'ok' : 'warn',
          detail: `Extracted: ${processed.convertedContent?.length || 0} chars`,
          timestamp: Date.now(),
        });
      }

      this.logger.info('File processed successfully', {
        name: file.name,
        tempPath,
        classifiedAs,
        hasConvertedContent: !!processed.convertedContent,
        totalDuration: Date.now() - diag.steps[0].timestamp,
      });

      diag.steps.push({ step: 'complete', status: 'ok', detail: 'File processed successfully', timestamp: Date.now() });
      return processed;
    } catch (error) {
      this.logger.error('Failed to download file', {
        name: file.name,
        error: error instanceof Error ? { message: error.message, name: error.name, stack: error.stack } : error,
      });
      diag.steps.push({
        step: 'download',
        status: 'error',
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        timestamp: Date.now(),
      });
      return null;
    }
  }

  /**
   * Validate that downloaded content matches the expected file type using magic bytes.
   * Detects cases where Slack returns HTML or other unexpected content.
   */
  private validateFileContent(buffer: Buffer, expectedMimetype: string, filename: string): { valid: boolean; detectedType: string; reason: string } {
    const firstBytes = buffer.slice(0, 16);
    const firstChars = buffer.slice(0, 100).toString('ascii');

    // Check for HTML content (most common failure mode)
    if (firstChars.trimStart().startsWith('<!DOCTYPE') || firstChars.trimStart().startsWith('<html')) {
      return { valid: false, detectedType: 'text/html', reason: 'Content appears to be HTML (likely a Slack login/error page)' };
    }

    // Magic byte signatures for common file types
    const signatures: { mimetype: string[]; magic: number[]; offset?: number; label: string }[] = [
      { mimetype: ['application/pdf'], magic: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
      { mimetype: ['image/png'], magic: [0x89, 0x50, 0x4E, 0x47], label: 'PNG' },
      { mimetype: ['image/jpeg'], magic: [0xFF, 0xD8, 0xFF], label: 'JPEG' },
      { mimetype: ['image/gif'], magic: [0x47, 0x49, 0x46, 0x38], label: 'GIF' },
      { mimetype: ['image/webp'], magic: [0x52, 0x49, 0x46, 0x46], label: 'RIFF/WebP' },
      { mimetype: ['application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], magic: [0x50, 0x4B, 0x03, 0x04], label: 'ZIP/OOXML' },
    ];

    // For known binary types, verify magic bytes match
    for (const sig of signatures) {
      if (sig.mimetype.includes(expectedMimetype)) {
        const offset = sig.offset || 0;
        const matches = sig.magic.every((byte, i) => firstBytes[offset + i] === byte);
        if (matches) {
          return { valid: true, detectedType: sig.label, reason: 'Magic bytes match' };
        }
        // Magic bytes don't match for expected binary type
        // Detect what it actually is
        for (const otherSig of signatures) {
          const otherMatches = otherSig.magic.every((byte, i) => firstBytes[i] === byte);
          if (otherMatches) {
            return { valid: false, detectedType: otherSig.label, reason: `Expected ${sig.label} but content is ${otherSig.label}` };
          }
        }
        return { valid: false, detectedType: 'unknown', reason: `Expected ${sig.label} but magic bytes don't match (got: ${firstBytes.slice(0, 4).toString('hex')})` };
      }
    }

    // For text/code files, just verify it's not binary garbage when we expect text
    if (expectedMimetype.startsWith('text/') || this.isTextFile(expectedMimetype, filename)) {
      return { valid: true, detectedType: 'text', reason: 'Text file (no magic byte check needed)' };
    }

    // For other types (application/octet-stream, etc.), accept as-is
    return { valid: true, detectedType: 'passthrough', reason: 'No specific validation for this type' };
  }

  private isImageFile(mimetype: string): boolean {
    return mimetype.startsWith('image/');
  }

  private isPdfFile(mimetype: string, filename?: string): boolean {
    if (mimetype === 'application/pdf') return true;
    if (filename) {
      return path.extname(filename).toLowerCase() === '.pdf';
    }
    return false;
  }

  private isDocxFile(mimetype: string, filename?: string): boolean {
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return true;
    if (mimetype === 'application/msword') return true;
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      return ext === '.docx' || ext === '.doc';
    }
    return false;
  }

  private isXlsxFile(mimetype: string, filename?: string): boolean {
    if (mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return true;
    if (mimetype === 'application/vnd.ms-excel') return true;
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      return ext === '.xlsx' || ext === '.xls';
    }
    return false;
  }

  private async convertDocxToText(buffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.messages.length > 0) {
        this.logger.debug('DOCX conversion messages', { messages: result.messages });
      }
      return result.value;
    } catch (error) {
      this.logger.error('Failed to convert DOCX to text', error);
      return '[DOCX conversion failed]';
    }
  }

  private convertXlsxToText(buffer: Buffer): string {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const parts: string[] = [];

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        if (csv.trim()) {
          parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
        }
      }

      return parts.join('\n\n');
    } catch (error) {
      this.logger.error('Failed to convert XLSX to text', error);
      return '[XLSX conversion failed]';
    }
  }

  private async convertPdfToText(buffer: Buffer): Promise<string> {
    try {
      const data = await pdfParse(buffer);
      this.logger.debug('PDF text extraction result', {
        pages: data.numpages,
        textLength: data.text?.length || 0,
        info: data.info,
      });
      if (data.text && data.text.trim().length > 0) {
        return data.text;
      }
      return '[PDF contains no extractable text (may be a scanned/image-based PDF)]';
    } catch (error) {
      this.logger.error('Failed to extract text from PDF', error);
      return '[PDF text extraction failed]';
    }
  }

  private isTextFile(mimetype: string, filename?: string): boolean {
    const textMimeTypes = [
      'text/',
      'application/json',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
      'application/x-sh',
      'application/x-python',
      'application/x-ruby',
      'application/x-perl',
      'application/x-httpd-php',
      'application/sql',
      'application/graphql',
      'application/toml',
      'application/x-toml',
    ];

    if (textMimeTypes.some(type => mimetype.startsWith(type))) {
      return true;
    }

    // Slack sometimes reports code files as application/octet-stream
    if (filename && mimetype === 'application/octet-stream') {
      const textExtensions = [
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
        '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
        '.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
        '.sh', '.bash', '.zsh', '.fish',
        '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
        '.json', '.jsonl', '.xml', '.csv', '.tsv',
        '.md', '.txt', '.rst', '.adoc',
        '.html', '.css', '.scss', '.less', '.sass',
        '.sql', '.graphql', '.gql',
        '.env', '.gitignore', '.dockerignore', '.editorconfig',
        '.vue', '.svelte', '.astro',
        '.tf', '.hcl', '.proto',
        '.r', '.R', '.jl', '.lua', '.php', '.pl', '.pm',
        '.ex', '.exs', '.erl', '.hs', '.elm', '.clj',
      ];
      const ext = path.extname(filename).toLowerCase();
      return textExtensions.includes(ext);
    }

    return false;
  }

  async formatFilePrompt(files: ProcessedFile[], userText: string): Promise<string> {
    let prompt = userText || 'Please analyze the uploaded files.';

    if (files.length > 0) {
      prompt += '\n\nUploaded files:\n';

      for (const file of files) {
        if (file.isImage) {
          prompt += `\n## Image: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `The image has been saved to: ${file.path}\n`;
          prompt += `IMPORTANT: Use the Read tool with file_path="${file.path}" to view and analyze this image.\n`;
        } else if (file.isPdf && file.convertedContent && !file.convertedContent.startsWith('[')) {
          // PDF with successfully extracted text
          prompt += `\n## PDF Document: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          const content = file.convertedContent;
          if (content.length > 10000) {
            prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
          } else {
            prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
          }
        } else if (file.isPdf) {
          // PDF where text extraction failed (scanned/image PDF) — fallback to Read tool
          prompt += `\n## PDF Document: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `Note: Text extraction failed (this may be a scanned/image-based PDF).\n`;
          prompt += `The PDF has been saved to: ${file.path}\n`;
          prompt += `You can try using the Read tool with file_path="${file.path}" to read this PDF.\n`;
        } else if (file.isDocx && file.convertedContent) {
          prompt += `\n## Word Document: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          const content = file.convertedContent;
          if (content.length > 10000) {
            prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
          } else {
            prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
          }
        } else if (file.isXlsx && file.convertedContent) {
          prompt += `\n## Spreadsheet: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          const content = file.convertedContent;
          if (content.length > 10000) {
            prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
          } else {
            prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
          }
        } else if (file.isText) {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;

          try {
            const content = fs.readFileSync(file.path, 'utf-8');
            if (content.length > 10000) {
              prompt += `Content (truncated to first 10000 characters):\n\`\`\`\n${content.substring(0, 10000)}...\n\`\`\`\n`;
            } else {
              prompt += `Content:\n\`\`\`\n${content}\n\`\`\`\n`;
            }
          } catch (error) {
            prompt += `Error reading file content: ${error}\n`;
          }
        } else {
          prompt += `\n## File: ${file.name}\n`;
          prompt += `File type: ${file.mimetype}\n`;
          prompt += `Size: ${file.size} bytes\n`;
          prompt += `The file has been saved to: ${file.path}\n`;
          prompt += `Note: This is a binary file. You can try using the Read tool with file_path="${file.path}" to analyze it.\n`;
        }
      }

      prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
    }

    this.logger.debug('Generated file prompt', {
      fileCount: files.length,
      promptLength: prompt.length,
      promptPreview: prompt.substring(0, 500),
    });

    return prompt;
  }

  /**
   * Move downloaded files from /tmp/ into a .claude-uploads/ subdirectory
   * of the working directory so that the Claude Code SDK can access them.
   */
  relocateToWorkingDirectory(files: ProcessedFile[], workingDirectory: string): void {
    const uploadDir = path.join(workingDirectory, '.claude-uploads');

    try {
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
    } catch (error) {
      this.logger.error('Failed to create upload directory, files stay in /tmp/', {
        uploadDir,
        error: error instanceof Error ? error.message : error,
      });
      return;
    }

    for (const file of files) {
      if (!file.tempPath) continue;

      const newPath = path.join(uploadDir, path.basename(file.tempPath));
      try {
        fs.copyFileSync(file.tempPath, newPath);
        fs.unlinkSync(file.tempPath); // remove original in /tmp/

        this.logger.info('Relocated file to working directory', {
          name: file.name,
          from: file.tempPath,
          to: newPath,
        });

        file.path = newPath;
        file.tempPath = newPath;
      } catch (error) {
        this.logger.error('Failed to relocate file, keeping in /tmp/', {
          name: file.name,
          from: file.tempPath,
          to: newPath,
          error: error instanceof Error ? error.message : error,
        });
        // leave original path untouched so it's still usable
      }
    }
  }

  async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
    const dirsToClean = new Set<string>();

    for (const file of files) {
      if (file.tempPath) {
        try {
          fs.unlinkSync(file.tempPath);
          this.logger.debug('Cleaned up temp file', { path: file.tempPath });
          dirsToClean.add(path.dirname(file.tempPath));
        } catch (error) {
          this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
        }
      }
    }

    // Remove .claude-uploads/ directory if it's now empty
    for (const dir of dirsToClean) {
      if (dir.endsWith('.claude-uploads')) {
        try {
          const remaining = fs.readdirSync(dir);
          if (remaining.length === 0) {
            fs.rmdirSync(dir);
            this.logger.debug('Removed empty upload directory', { dir });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  /** Format diagnostic results for display in Slack */
  formatDiagnostics(diagnostics: FileProcessingDiagnostic[]): string {
    if (diagnostics.length === 0) return '';

    const hasIssues = diagnostics.some(d => d.status !== 'success');
    if (!hasIssues) return '';

    let msg = '🔍 *File Processing Diagnostics:*\n';

    for (const diag of diagnostics) {
      const statusIcon = diag.status === 'success' ? '✅' : diag.status === 'skipped' ? '⏭️' : '❌';
      msg += `\n${statusIcon} *${diag.fileName}* (${diag.duration}ms)\n`;

      for (const step of diag.steps) {
        const icon = step.status === 'ok' ? '  ✓' : step.status === 'warn' ? '  ⚠️' : '  ✗';
        msg += `${icon} \`${step.step}\`: ${step.detail}\n`;
      }
    }

    return msg;
  }

  getSupportedFileTypes(): string[] {
    return [
      'Images: jpg, png, gif, webp, svg',
      'Text files: txt, md, json, js, ts, py, java, etc.',
      'Documents: pdf, docx, doc, xlsx, xls',
      'Code files: most programming languages',
    ];
  }
}

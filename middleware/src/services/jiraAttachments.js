import { extname } from 'node:path';
import { URL } from 'node:url';
import { config } from '../config.js';
import { sanitizeUntrustedText } from '../utils/sanitize.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.xml']);
const DOCX_EXTENSION = '.docx';
const PDF_EXTENSION = '.pdf';

export async function readJiraAttachments(attachments = [], options = {}) {
  const settings = {
    jiraBaseUrl: options.jiraBaseUrl ?? config.jiraBaseUrl,
    jiraEmail: options.jiraEmail ?? config.jiraEmail,
    jiraApiToken: options.jiraApiToken ?? config.jiraApiToken,
    maxAttachments: options.maxAttachments ?? config.maxJiraAttachments,
    maxAttachmentBytes: options.maxAttachmentBytes ?? config.maxJiraAttachmentBytes,
    maxAttachmentText: options.maxAttachmentText ?? config.maxJiraAttachmentText,
    fetchImpl: options.fetchImpl || fetch,
    docxParser: options.docxParser,
    pdfParser: options.pdfParser
  };
  const attachmentContents = [];
  const attachmentFailures = [];
  const skippedAttachments = [];
  const selected = attachments.slice(0, settings.maxAttachments);

  for (const attachment of selected) {
    if (!isSupportedAttachment(attachment)) {
      skippedAttachments.push(publicAttachment(attachment, 'Unsupported attachment type; metadata retained but content was not read.'));
      continue;
    }
    try {
      validateAttachment(attachment, settings.maxAttachmentBytes);
      const endpoint = attachmentEndpoint(settings.jiraBaseUrl, attachment.id);
      const response = await settings.fetchImpl(endpoint, {
        headers: {
          Accept: '*/*',
          Authorization: `Basic ${Buffer.from(`${settings.jiraEmail}:${settings.jiraApiToken}`).toString('base64')}`
        },
        redirect: 'follow'
      });
      if (!response.ok) throw new Error(`Jira returned HTTP ${response.status}.`);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > settings.maxAttachmentBytes) throw new Error(`Attachment exceeds the ${settings.maxAttachmentBytes}-byte limit.`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > settings.maxAttachmentBytes) throw new Error(`Attachment exceeds the ${settings.maxAttachmentBytes}-byte limit.`);
      attachmentContents.push(await extractAttachmentText(attachment, buffer, settings));
    } catch (error) {
      attachmentFailures.push({ fileName: sanitizeUntrustedText(attachment?.filename, 255), reason: sanitizeUntrustedText(error.message, 500) });
    }
  }

  for (const attachment of attachments.slice(settings.maxAttachments)) {
    attachmentFailures.push({ fileName: sanitizeUntrustedText(attachment?.filename, 255), reason: `Attachment count exceeds the configured limit of ${settings.maxAttachments}.` });
  }
  return { attachmentContents, attachmentFailures, skippedAttachments };
}

export async function extractAttachmentText(attachment, buffer, options = {}) {
  const extension = extname(String(attachment?.filename || '')).toLowerCase();
  let text;
  if (TEXT_EXTENSIONS.has(extension)) {
    text = buffer.toString('utf8');
  } else if (extension === DOCX_EXTENSION) {
    const parser = options.docxParser || defaultDocxParser;
    text = await parser(buffer);
  } else if (extension === PDF_EXTENSION) {
    const parser = options.pdfParser || defaultPdfParser;
    text = await parser(buffer);
  } else {
    throw new Error('Unsupported attachment type.');
  }
  const maxText = options.maxAttachmentText ?? config.maxJiraAttachmentText;
  const sanitized = sanitizeUntrustedText(text, maxText);
  return {
    id: String(attachment.id),
    filename: sanitizeUntrustedText(attachment.filename, 255),
    mimeType: sanitizeUntrustedText(attachment.mimeType, 150),
    text: sanitized,
    truncated: String(text || '').length > maxText
  };
}

function validateAttachment(attachment, maxBytes) {
  if (!/^\d+$/.test(String(attachment?.id || ''))) throw new Error('Attachment ID is invalid.');
  const size = Number(attachment?.size || 0);
  if (!Number.isFinite(size) || size < 0) throw new Error('Attachment size is invalid.');
  if (size > maxBytes) throw new Error(`Attachment exceeds the ${maxBytes}-byte limit.`);
}

function isSupportedAttachment(attachment) {
  const extension = extname(String(attachment?.filename || '')).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || extension === DOCX_EXTENSION || extension === PDF_EXTENSION;
}

function attachmentEndpoint(baseUrl, attachmentId) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') throw new Error('Jira attachment downloads require HTTPS.');
  if (!/^\d+$/.test(String(attachmentId || ''))) throw new Error('Attachment ID is invalid.');
  return new URL(`/rest/api/3/attachment/content/${attachmentId}`, base.origin).toString();
}

async function defaultDocxParser(buffer) {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function defaultPdfParser(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function publicAttachment(attachment, reason) {
  return {
    id: String(attachment?.id || ''),
    filename: sanitizeUntrustedText(attachment?.filename, 255),
    mimeType: sanitizeUntrustedText(attachment?.mimeType, 150),
    size: Number(attachment?.size || 0),
    reason
  };
}

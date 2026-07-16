import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer, Paragraph } from 'docx';
import PDFDocument from 'pdfkit';
import { extractAttachmentText, readJiraAttachments } from '../src/services/jiraAttachments.js';

test('extracts and sanitizes supported plain-text Jira attachments', async () => {
  const result = await extractAttachmentText(
    { id: '17450', filename: 'requirements.md', mimeType: 'text/markdown', size: 80 },
    Buffer.from('Create a consent Flow.\u0000\napi_token=super-secret')
  );

  assert.match(result.text, /Create a consent Flow/);
  assert.doesNotMatch(result.text, /super-secret/);
  assert.match(result.text, /\[REDACTED\]/);
});

test('uses a document parser for DOCX content', async () => {
  const result = await extractAttachmentText(
    { id: '17450', filename: 'requirements.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 20 },
    Buffer.from('zip-data'),
    { docxParser: async () => 'Consent collection requirements' }
  );

  assert.equal(result.text, 'Consent collection requirements');
});

test('default DOCX and PDF parsers extract real requirement text', async () => {
  const docxBuffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('DOCX consent requirement')] }] }));
  const pdfBuffer = await createPdf('PDF consent requirement');
  const docxResult = await extractAttachmentText({ id: '10', filename: 'requirements.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: docxBuffer.length }, docxBuffer);
  const pdfResult = await extractAttachmentText({ id: '11', filename: 'requirements.pdf', mimeType: 'application/pdf', size: pdfBuffer.length }, pdfBuffer);

  assert.match(docxResult.text, /DOCX consent requirement/);
  assert.match(pdfResult.text, /PDF consent requirement/);
});

test('downloads attachments only through the configured Jira attachment endpoint', async () => {
  const requested = [];
  const result = await readJiraAttachments(
    [{ id: '17450', filename: 'requirements.txt', mimeType: 'text/plain', size: 12 }],
    {
      jiraBaseUrl: 'https://example.atlassian.net',
      jiraEmail: 'developer@example.com',
      jiraApiToken: 'secret',
      fetchImpl: async (url, options) => {
        requested.push({ url, options });
        return response('Build a Flow', 200, { 'content-length': '12' });
      }
    }
  );

  assert.equal(requested[0].url, 'https://example.atlassian.net/rest/api/3/attachment/content/17450');
  assert.match(requested[0].options.headers.Authorization, /^Basic /);
  assert.equal(result.attachmentContents[0].text, 'Build a Flow');
  assert.equal(result.attachmentFailures.length, 0);
});

test('rejects invalid attachment IDs and oversized documents before download', async () => {
  let fetchCalls = 0;
  const result = await readJiraAttachments(
    [
      { id: '../secret', filename: 'bad.txt', mimeType: 'text/plain', size: 1 },
      { id: '2', filename: 'large.pdf', mimeType: 'application/pdf', size: 101 }
    ],
    {
      jiraBaseUrl: 'https://example.atlassian.net',
      jiraEmail: 'developer@example.com',
      jiraApiToken: 'secret',
      maxAttachmentBytes: 100,
      fetchImpl: async () => { fetchCalls += 1; return response('unexpected'); }
    }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(result.attachmentFailures.length, 2);
});

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    arrayBuffer: async () => Buffer.from(body)
  };
}

function createPdf(text) {
  return new Promise((resolve) => {
    const chunks = [];
    const document = new PDFDocument();
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.text(text);
    document.end();
  });
}

test('skips unsupported binary attachment types without parsing them', async () => {
  const result = await readJiraAttachments(
    [{ id: '3', filename: 'screenshot.png', mimeType: 'image/png', size: 20 }],
    { jiraBaseUrl: 'https://example.atlassian.net', jiraEmail: 'a', jiraApiToken: 'b' }
  );

  assert.equal(result.attachmentContents.length, 0);
  assert.equal(result.attachmentFailures.length, 0);
  assert.equal(result.skippedAttachments[0].filename, 'screenshot.png');
});

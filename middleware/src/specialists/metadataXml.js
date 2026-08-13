const NS = 'http://soap.sforce.com/2006/04/metadata';
const MAX_BYTES = 500000;
const MAX_DEPTH = 64;

export function parseMetadataXml(source, expectedRoot) {
  const xml = String(source || '').trim();
  if (!xml || Buffer.byteLength(xml, 'utf8') > MAX_BYTES || /```|\bTODO\b|rest omitted|placeholder/i.test(xml) || /<!DOCTYPE|<!ENTITY|<!\[CDATA\[|<!--|<\?(?!xml\s)|\?>[\s\S]*<\?/i.test(xml)) throw xmlError();
  const declaration = xml.match(/^<\?xml\s+version=["']1\.0["'](?:\s+encoding=["'][A-Za-z0-9_-]+["'])?\s*\?>/);
  if (!declaration) throw xmlError();
  const body = xml.slice(declaration[0].length).trim();
  const tokenPattern = /<([^>]+)>|([^<]+)/g;
  const stack = [];
  let root = null; let match; let cursor = 0;
  while ((match = tokenPattern.exec(body))) {
    if (match.index !== cursor) throw xmlError();
    cursor = tokenPattern.lastIndex;
    if (match[2] !== undefined) {
      if (stack.length) stack.at(-1).text += decodeText(match[2]);
      else if (match[2].trim()) throw xmlError();
      continue;
    }
    const token = match[1].trim();
    if (!token || token.startsWith('!') || token.startsWith('?')) throw xmlError();
    if (token.startsWith('/')) {
      const name = token.slice(1).trim();
      if (!stack.length || stack.at(-1).name !== name) throw xmlError();
      stack.pop();
      continue;
    }
    const selfClosing = token.endsWith('/');
    const opening = selfClosing ? token.slice(0, -1).trim() : token;
    const nameMatch = opening.match(/^([A-Za-z_][A-Za-z0-9_.:-]*)([\s\S]*)$/);
    if (!nameMatch) throw xmlError();
    const node = { name: nameMatch[1], attributes: parseAttributes(nameMatch[2]), children: [], text: '' };
    if (stack.length) stack.at(-1).children.push(node);
    else if (root) throw xmlError();
    else root = node;
    if (!selfClosing) { stack.push(node); if (stack.length > MAX_DEPTH) throw xmlError(); }
  }
  if (cursor !== body.length || stack.length || !root || root.name !== expectedRoot || root.attributes.xmlns !== NS || Object.keys(root.attributes).some((key) => key !== 'xmlns')) throw xmlError();
  return {
    root,
    children(node, name) { return (node?.children || []).filter((child) => child.name === name); },
    child(node, name) { return (node?.children || []).find((child) => child.name === name) || null; },
    text(node, name) { return (node?.children || []).find((child) => child.name === name)?.text.trim() || ''; }
  };
}

function parseAttributes(value) {
  const attrs = {}; let rest = value;
  const pattern = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])(.*?)\2/;
  while (rest) {
    const match = rest.match(pattern);
    if (!match) { if (rest.trim()) throw xmlError(); break; }
    if (attrs[match[1]] !== undefined) throw xmlError();
    attrs[match[1]] = decodeText(match[3]); rest = rest.slice(match[0].length);
  }
  return attrs;
}

function decodeText(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)) throw xmlError();
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function xmlError() { return Object.assign(new Error('Invalid or unsafe Salesforce metadata XML.'), { code: 'SPECIALIST_XML_INVALID', statusCode: 409 }); }

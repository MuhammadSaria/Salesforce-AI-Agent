import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMetadataXml } from '../src/specialists/metadataXml.js';

const NS = 'http://soap.sforce.com/2006/04/metadata';

test('parses one bounded Salesforce metadata document', () => {
  const parsed = parseMetadataXml(`<?xml version="1.0" encoding="UTF-8"?><CustomField xmlns="${NS}"><fullName>Installment_Number__c</fullName><type>Number</type></CustomField>`, 'CustomField');
  assert.equal(parsed.root.name, 'CustomField');
  assert.equal(parsed.text(parsed.root, 'fullName'), 'Installment_Number__c');
});

for (const [name, xml] of [
  ['malformed', `<?xml version="1.0"?><Flow xmlns="${NS}"><status>Draft</Flow>`],
  ['multiple roots', `<?xml version="1.0"?><Flow xmlns="${NS}"></Flow><Flow xmlns="${NS}"></Flow>`],
  ['doctype', `<?xml version="1.0"?><!DOCTYPE Flow><Flow xmlns="${NS}"></Flow>`],
  ['entity', `<?xml version="1.0"?><!DOCTYPE Flow [<!ENTITY x SYSTEM "file:///etc/passwd">]><Flow xmlns="${NS}">&x;</Flow>`],
  ['wrong root', `<?xml version="1.0"?><PermissionSet xmlns="${NS}"></PermissionSet>`],
  ['wrong namespace', '<?xml version="1.0"?><Flow xmlns="urn:wrong"></Flow>'],
  ['trailing document', `<?xml version="1.0"?><Flow xmlns="${NS}"></Flow><?xml version="1.0"?><Flow xmlns="${NS}"></Flow>`],
  ['cdata spoof', `<?xml version="1.0"?><Flow xmlns="${NS}"><![CDATA[<status>Draft</status>]]></Flow>`],
  ['comment spoof', `<?xml version="1.0"?><Flow xmlns="${NS}"><!-- <status>Draft</status> --></Flow>`],
  ['processing instruction', `<?xml version="1.0"?><Flow xmlns="${NS}"><?evil data?></Flow>`],
  ['markdown', `\`\`\`xml\n<Flow xmlns="${NS}"></Flow>\n\`\`\``],
  ['placeholder', `<?xml version="1.0"?><Flow xmlns="${NS}"><description>TODO</description></Flow>`]
]) {
  test(`rejects ${name} XML`, () => assert.throws(() => parseMetadataXml(xml, 'Flow'), (error) => error.code === 'SPECIALIST_XML_INVALID'));
}

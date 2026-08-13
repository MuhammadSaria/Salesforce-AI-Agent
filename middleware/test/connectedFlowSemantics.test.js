import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecurringDonationFlow } from '../src/specialists/flowSemantics.js';
import { connectedFlowXml } from './fixtures/connectedFlow.js';

const context = { objectApiName: 'GiftTransaction', installmentField: 'Installment_Number__c', relationshipField: 'GiftCommitmentId', statusField: 'Status', completedValue: 'Completed' };

test('accepts one connected executable recurring-donation Flow', () => assert.doesNotThrow(() => validateRecurringDonationFlow(connectedFlowXml(), context)));

for (const [name, mutate] of [
  ['disconnected lookup', (xml) => xml.replace('<targetReference>Highest_Same_Parent</targetReference>', '<targetReference>Has_Previous_Number</targetReference>')],
  ['disconnected decision', (xml) => xml.replace('<targetReference>Has_Previous_Number</targetReference>', '<targetReference>Assign_First</targetReference>')],
  ['disconnected assignment', (xml) => xml.replace('<targetReference>Assign_Increment</targetReference>', '<targetReference>Assign_First</targetReference>')],
  ['reversed connector', (xml) => xml.replace('<targetReference>Highest_Same_Parent</targetReference>', '<targetReference>Assign_Increment</targetReference>')],
  ['wrong parent filter', (xml) => xml.replace('$Record.GiftCommitmentId', '$Record.OtherParentId')],
  ['missing null-number lookup filter', (xml) => xml.replace(/<filters><field>Installment_Number__c<\/field>[\s\S]*?<\/filters>/, '')],
  ['ascending sort', (xml) => xml.replace('<sortOrder>Desc</sortOrder>', '<sortOrder>Asc</sortOrder>')],
  ['multiple-record lookup', (xml) => xml.replace('<getFirstRecordOnly>true</getFirstRecordOnly>', '<getFirstRecordOnly>false</getFirstRecordOnly>')],
  ['wrong assignment field', (xml) => xml.replaceAll('$Record.Installment_Number__c', '$Record.Other__c')],
  ['constant increment', (xml) => xml.replace('{!Highest_Same_Parent.Installment_Number__c} + 1', '2')],
  ['overwrite enabled', (xml) => xml.replace(/<filters><field>Installment_Number__c<\/field><operator>IsNull<\/operator><value><booleanValue>true<\/booleanValue><\/value><\/filters>/, '')],
  ['update only', (xml) => xml.replace('<recordTriggerType>CreateAndUpdate</recordTriggerType>', '<recordTriggerType>Update</recordTriggerType>')],
  ['create only', (xml) => xml.replace('<recordTriggerType>CreateAndUpdate</recordTriggerType>', '<recordTriggerType>Create</recordTriggerType>')],
  ['reversal clear', (xml) => xml.replace('</Flow>', '<assignments><name>Clear_On_Reversal</name><assignmentItems><assignToReference>$Record.Installment_Number__c</assignToReference><operator>Assign</operator><value><stringValue></stringValue></value></assignmentItems></assignments></Flow>')],
  ['historical renumber', (xml) => xml.replace('<doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria>', '<doesRequireRecordChangedToMeetCriteria>false</doesRequireRecordChangedToMeetCriteria>')],
  ['wrong status', (xml) => xml.replace('<stringValue>Completed</stringValue>', '<stringValue>Paid</stringValue>')],
  ['active status', (xml) => xml.replace('<status>Draft</status>', '<status>Active</status>')],
  ['markers without behavior', () => '<?xml version="1.0"?><Flow xmlns="http://soap.sforce.com/2006/04/metadata"><description>CREATE_AS_COMPLETED SAME_PARENT_LOOKUP</description><status>Draft</status></Flow>']
]) test(`rejects ${name}`, () => assert.throws(() => validateRecurringDonationFlow(mutate(connectedFlowXml()), context), (error) => ['SPECIALIST_FLOW_INVALID', 'FLOW_MUST_BE_INACTIVE'].includes(error.code)));

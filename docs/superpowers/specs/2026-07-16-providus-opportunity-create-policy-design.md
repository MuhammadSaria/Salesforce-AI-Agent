# Providus Opportunity Create Policy

## Purpose

Allow Providus Nexus to prepare and, after the existing explicit approvals, create donation-style records in the Providus Technology Developer Org. Read-only discovery confirmed that this org has no dedicated Donation object, so the supported record model for this ticket is the standard Opportunity object.

## Policy Design

- Enable Salesforce data mutations for the registered org `providus_orgfarm_dev`.
- Allow only the `Opportunity` object.
- Allow only the `data-create` operation.
- Keep record updates and deletions blocked.
- Limit an approved execution to no more than ten data operations.
- Preserve org verification, plan approval, validation, and separate data-execution approval requirements.

## Ticket Handling

The existing TA-8 plan is not sufficient because an Opportunity requires values beyond Account and Amount. After the policy change, the job must be reanalyzed and present the required Opportunity Name, Stage, Close Date, exact Account, and four Amount values for human review. No records are created by this policy change.

## Verification

An automated policy test will confirm that Opportunity creation is enabled while Account access, record updates, and record deletion remain disabled. The complete middleware check will then be run.


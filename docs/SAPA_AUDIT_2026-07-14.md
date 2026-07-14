# SAPA Sandbox Audit - 2026-07-14

Target org: SAPA Dev Sandbox (`00DVZ0000042tir2AA`)

## Agent Console Deployment

- Component: `LightningComponentBundle:agentChat`
- Deployment ID: `0AfVZ00000EUWon0AH`
- Result: Succeeded

## Existing Test Repairs

The following existing sandbox test classes were selectively retrieved, repaired, validated, and deployed:

- `CampaignHierarchyReportingBatch_Test`: avoids colliding with the existing scheduled job.
- `LightningSelfRegisterControllerTest`: uses the sandbox Business Account record type.
- `RuntimeCampaignGiftHierarchy_Test`: replaces hard-coded cross-org record type IDs.
- `StripeVoidServiceTestCls`: creates valid GiftCommitment test data with required fields.
- `TriggerOnOSC_Test`: creates its own Campaign and verifies the active rollup behavior.

Deployment ID: `0AfVZ00000EUXOH0A5`

Result: 5 components deployed; 19 of 19 targeted tests passed.

## Final Validation

- Validation ID: `0AfVZ00000EUWAU0A5`
- Result: Succeeded (check-only)
- Components: 14 of 14
- Local Apex tests: 163 of 163
- Component errors: 0
- Test failures: 0

No production org was accessed or modified.

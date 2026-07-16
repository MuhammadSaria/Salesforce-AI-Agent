# Providus Nexus Salesforce App Branding Design

## Purpose

Align the Salesforce Lightning application surrounding the `agentChat` component with the Providus Nexus product identity.

## Approved Branding

- Lightning app label: `Providus Nexus`
- App-page and navigation-tab label: `Providus Nexus Workspace`
- User permission-set label: `Providus Nexus User`
- Executor permission-set label: `Providus Nexus Executor`

## Metadata Stability

Keep these metadata API names unchanged:

- Custom application: `AI_Agent`
- Custom tab: `Agent_Console`
- FlexiPage: `Agent_Console`
- Permission sets: `AI_Agent_User` and `AI_Agent_Executor`
- LWC bundle: `agentChat`

Preserving the API names keeps current permission references, navigation assignments, installed links, and deployment history intact.

## User Experience

The Salesforce App Launcher will display `Providus Nexus`. Opening the app will show the `Providus Nexus Workspace` navigation item and app page containing the existing Providus Nexus LWC. Existing users retain access through the same permission sets; only the permission-set labels change.

## Scope

Modify only the visible labels in:

- `force-app/main/default/applications/AI_Agent.app-meta.xml`
- `force-app/main/default/tabs/Agent_Console.tab-meta.xml`
- `force-app/main/default/flexipages/Agent_Console.flexipage-meta.xml`
- `force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml`
- `force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml`

Do not change application navigation, FlexiPage composition, Apex access, custom permissions, tab visibility, or the Salesforce org assignment.

## Verification And Deployment

- Add a repository test that parses each metadata file and verifies the approved labels and unchanged cross-references.
- Run the new metadata test and the complete LWC Jest suite.
- Reverify alias `orgfarm-dev` against Salesforce Organization ID `00Dg500000E07e9EAB`, the registered instance URL, and the registered username.
- Deploy only `CustomApplication:AI_Agent`, `CustomTab:Agent_Console`, `FlexiPage:Agent_Console`, `PermissionSet:AI_Agent_User`, and `PermissionSet:AI_Agent_Executor`.

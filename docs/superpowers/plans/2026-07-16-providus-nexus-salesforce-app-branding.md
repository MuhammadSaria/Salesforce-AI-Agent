# Providus Nexus Salesforce App Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the visible Salesforce Lightning app, workspace tab/page, and permission-set labels to Providus Nexus without changing metadata API names or access behavior.

**Architecture:** Add a PowerShell metadata contract test that parses the five XML files with the platform XML parser and verifies both the approved labels and stable cross-references. Update only `<label>` and `<masterLabel>` values, then selectively deploy the five metadata components to the exact verified Developer Org.

**Tech Stack:** Salesforce Metadata API XML, PowerShell XML parser, Salesforce CLI, LWC Jest.

## Global Constraints

- Keep API names `AI_Agent`, `Agent_Console`, `AI_Agent_User`, `AI_Agent_Executor`, and `agentChat` unchanged.
- Keep application navigation, FlexiPage composition, Apex access, custom permissions, and tab visibility unchanged.
- Deploy only to alias `orgfarm-dev` after verifying Salesforce Organization ID `00Dg500000E07e9EAB`, the registered instance URL, and the registered username.
- Do not deploy any unrelated dirty working-tree files.

---

### Task 1: Metadata Branding Contract

**Files:**
- Create: `scripts/test-providus-nexus-app-branding.ps1`
- Modify: `force-app/main/default/applications/AI_Agent.app-meta.xml`
- Modify: `force-app/main/default/tabs/Agent_Console.tab-meta.xml`
- Modify: `force-app/main/default/flexipages/Agent_Console.flexipage-meta.xml`
- Modify: `force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml`
- Modify: `force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml`

**Interfaces:**
- Consumes: repository-relative metadata paths and Salesforce Metadata API XML namespaces.
- Produces: exit code `0` when all visible labels and stable references match the approved design; throws with a descriptive mismatch when they do not.

- [ ] **Step 1: Create the failing metadata contract test**

Create `scripts/test-providus-nexus-app-branding.ps1` with a helper that parses XML and reads namespaced elements:

```powershell
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Read-MetadataXml([string]$relativePath) {
    $path = Join-Path $root $relativePath
    [xml]$document = Get-Content -Raw -LiteralPath $path
    return $document
}

function Assert-Equal([string]$actual, [string]$expected, [string]$description) {
    if ($actual -ne $expected) {
        throw "$description mismatch. Expected '$expected' but received '$actual'."
    }
}

$application = Read-MetadataXml 'force-app/main/default/applications/AI_Agent.app-meta.xml'
$tab = Read-MetadataXml 'force-app/main/default/tabs/Agent_Console.tab-meta.xml'
$page = Read-MetadataXml 'force-app/main/default/flexipages/Agent_Console.flexipage-meta.xml'
$userPermission = Read-MetadataXml 'force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml'
$executorPermission = Read-MetadataXml 'force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml'

Assert-Equal $application.CustomApplication.label 'Providus Nexus' 'Application label'
Assert-Equal $application.CustomApplication.tabs 'Agent_Console' 'Application tab API name'
Assert-Equal $tab.CustomTab.label 'Providus Nexus Workspace' 'Tab label'
Assert-Equal $tab.CustomTab.flexiPage 'Agent_Console' 'Tab FlexiPage API name'
Assert-Equal $page.FlexiPage.masterLabel 'Providus Nexus Workspace' 'FlexiPage label'
Assert-Equal $page.FlexiPage.flexiPageRegions.itemInstances.componentInstance.componentName 'c:agentChat' 'FlexiPage component API name'
Assert-Equal $userPermission.PermissionSet.label 'Providus Nexus User' 'User permission-set label'
Assert-Equal $userPermission.PermissionSet.applicationVisibilities.application 'AI_Agent' 'Permission-set application API name'
Assert-Equal $executorPermission.PermissionSet.label 'Providus Nexus Executor' 'Executor permission-set label'

Write-Output 'Providus Nexus Salesforce app branding metadata is valid.'
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-providus-nexus-app-branding.ps1
```

Expected: FAIL at `Application label` because the existing value is `AI Agent`.

- [ ] **Step 3: Update only the approved visible labels**

Apply these exact replacements:

```text
applications/AI_Agent.app-meta.xml: AI Agent -> Providus Nexus
tabs/Agent_Console.tab-meta.xml: Agent Console -> Providus Nexus Workspace
flexipages/Agent_Console.flexipage-meta.xml: Agent Console -> Providus Nexus Workspace
permissionsets/AI_Agent_User.permissionset-meta.xml: AI Agent User -> Providus Nexus User
permissionsets/AI_Agent_Executor.permissionset-meta.xml: AI Agent Executor -> Providus Nexus Executor
```

Do not rename the files or change any API-name element.

- [ ] **Step 4: Run the contract test and verify it passes**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-providus-nexus-app-branding.ps1
```

Expected: `Providus Nexus Salesforce app branding metadata is valid.`

- [ ] **Step 5: Run the LWC regression suite**

Run:

```powershell
cmd /c npm run test:unit -- --runInBand
```

Expected: 13 tests pass and 0 fail.

### Task 2: Commit, Publish, And Selectively Deploy

**Files:**
- Commit only the six files from Task 1.
- Deploy only the five Salesforce metadata components from Task 1.

**Interfaces:**
- Consumes: the passing branding contract, passing LWC tests, registered org context, and existing Salesforce CLI authentication.
- Produces: a Git commit, updated remote feature branch/PR, and a successful Salesforce deployment ID for the exact Developer Org.

- [ ] **Step 1: Verify the scoped diff**

Run:

```powershell
git diff --check -- scripts/test-providus-nexus-app-branding.ps1 force-app/main/default/applications/AI_Agent.app-meta.xml force-app/main/default/tabs/Agent_Console.tab-meta.xml force-app/main/default/flexipages/Agent_Console.flexipage-meta.xml force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml
```

Expected: no whitespace errors. Confirm manually that only the five approved label values changed in Salesforce metadata.

- [ ] **Step 2: Commit the scoped files**

```powershell
git add -- scripts/test-providus-nexus-app-branding.ps1 force-app/main/default/applications/AI_Agent.app-meta.xml force-app/main/default/tabs/Agent_Console.tab-meta.xml force-app/main/default/flexipages/Agent_Console.flexipage-meta.xml force-app/main/default/permissionsets/AI_Agent_User.permissionset-meta.xml force-app/main/default/permissionsets/AI_Agent_Executor.permissionset-meta.xml
git commit -m "Brand Salesforce app as Providus Nexus"
git push
```

- [ ] **Step 3: Reverify the exact Salesforce org**

Run `sf org display --target-org orgfarm-dev --json` and safely parse the response without printing credentials. Require:

```text
Organization ID: 00Dg500000E07e9EAB
Instance URL: https://orgfarm-9914d7f2f7-dev-ed.develop.my.salesforce.com
Username: saria4505102.8535b64837ad@agentforce.com
Connected status: Connected
```

- [ ] **Step 4: Deploy only the approved metadata components**

Run:

```powershell
sf project deploy start --metadata CustomApplication:AI_Agent --metadata CustomTab:Agent_Console --metadata FlexiPage:Agent_Console --metadata PermissionSet:AI_Agent_User --metadata PermissionSet:AI_Agent_Executor --target-org orgfarm-dev --wait 30 --json
```

Expected: `Succeeded`, 5 components deployed, 0 component errors.

- [ ] **Step 5: Verify the deployment report**

Read the deployment ID from the parsed Step 4 response into `$deploymentId`, then run:

```powershell
sf project deploy report --job-id $deploymentId --target-org orgfarm-dev --json
```

Require `Succeeded` with zero component errors.

## Completion Criteria

- The App Launcher displays `Providus Nexus`.
- The navigation tab and FlexiPage display `Providus Nexus Workspace`.
- Permission labels display `Providus Nexus User` and `Providus Nexus Executor`.
- All existing API references remain unchanged.
- The metadata contract and all 13 LWC tests pass.
- The remote pull request contains the branding commit.
- The selective Salesforce deployment succeeds in org `00Dg500000E07e9EAB`.

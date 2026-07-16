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

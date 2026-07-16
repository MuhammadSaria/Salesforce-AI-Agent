# Providus Nexus LWC UI Design

## Purpose

Refresh the existing `agentChat` Lightning Web Component as a professional Salesforce delivery workspace branded as **Providus Nexus**. The change improves hierarchy, interaction, readability, and responsive behavior without changing the supervised job workflow, Apex contracts, or approval safeguards.

## Design Direction

Use a compact, Salesforce-native operational workspace. Providus Nexus is the primary product identity. Specialist agents remain visible as supporting delivery roles, but their details are collapsed by default so the user can focus on the current job state and required decision.

The interface uses a restrained palette of white, neutral gray, Salesforce blue, success green, warning amber, and error red. It avoids marketing-style composition, decorative graphics, and excessive card nesting.

## Information Architecture

The component presents information in this order:

1. **Providus Nexus header** with the product name, a short Salesforce delivery subtitle, current status, and refresh action.
2. **Job workspace** with the assigned Jira task selector and compact controls for creating a supervised job.
3. **Verified org strip** with customer, target org, environment, Salesforce Organization ID, and verification status.
4. **Five-stage progress indicator** covering Analysis, Plan, Implementation, Validation, and Deployment.
5. **Current action panel** explaining what Providus Nexus is doing or what the user must approve next.
6. **Collapsible job sections** for the Jira requirement, unified implementation plan, specialist progress, validation, deployment results, and implementation reports.
7. **Persistent instruction area** for corrections and additional requirements throughout the job lifecycle.
8. **Contextual action bar** containing only actions permitted by the current job state.

Production warnings, data-change warnings, destructive-action warnings, validation failures, and deployment results remain prominent and are never hidden behind optional specialist details.

## Component Behavior

The existing Apex methods and middleware response structures remain unchanged. The LWC derives its presentation from the current job payload and status.

- Loading disables duplicate submissions and displays a clear working state.
- Selecting a job refreshes the workspace and progress indicator.
- Specialist progress initially shows a summary. The user can expand it to inspect individual work items.
- Approval, implementation, validation, and deployment controls remain governed by the existing state machine.
- The instruction control remains available before implementation, after implementation, before deployment, and after deployment, except for cancelled jobs.
- Error, validation-failure, deployment-success, empty, and report-ready states use distinct semantic presentation and accessible text.
- Production and destructive actions retain their current warnings and separate approvals.
- No chat interface is reintroduced.

## Progress Mapping

The five visual stages are derived from the existing parent job state:

- **Analysis:** received, org selection, org verification, Jira analysis, metadata discovery, retrieval, and dependency analysis.
- **Plan:** unified plan preparation and implementation approval.
- **Implementation:** approved local source changes.
- **Validation:** Salesforce dry run and applicable tests.
- **Deployment:** deployment approval, deployment, and completion.

Completed stages display success styling, the active stage displays emphasis and an activity indicator, future stages remain neutral, and failed stages display error styling. Existing detailed status text remains available in the header and action panel.

## Specialist Progress

Specialist activity is presented as one collapsible section under the Providus Nexus workspace. Its collapsed summary contains the orchestration iteration, overall specialist status, and completed-item count. When expanded, it displays each specialist's name, responsibility, proposed work, status, and whether previously completed work was preserved.

Specialists do not receive separate user approval controls. The existing unified implementation approval remains the only implementation approval.

## Visual And Responsive Rules

- Use Lightning icons and Salesforce Lightning Design System controls.
- Use a stable responsive grid for header context, progress, job controls, and actions.
- Keep operational labels compact while giving implementation recommendations comfortable line height and readable sizing.
- Use visible hover and keyboard focus states for interactive regions.
- Stack grids and actions on narrow record-page and mobile widths without text overlap.
- Avoid fixed heights for variable job content.
- Keep the primary decision and required action visually stronger than supporting detail.
- Use `Providus Nexus` as the visible component name and metadata master label.

## Accessibility

- Preserve semantic headings and labeled regions.
- Retain `role="alert"` for errors and high-risk warnings.
- Provide alternative text for icons and spinner states.
- Ensure collapsible controls expose their expanded state and have descriptive labels.
- Do not rely on color alone to communicate progress or failure.

## Testing

LWC Jest tests will verify:

- Providus Nexus branding and the removal of the old visible product title.
- Professional workspace regions and five-stage progress presentation.
- Specialist details are collapsed by default and can be expanded.
- Existing implementation and deployment approvals remain separate.
- Persistent instructions still work in supported states.
- Production and destructive warnings remain visible.
- Validation failures remain human-readable and block deployment approval.
- Deployment details and versioned implementation-report downloads remain available.
- Existing job creation, selection, polling, and Apex action contracts are preserved.

## Scope Boundaries

This change is limited to the `agentChat` LWC presentation, client-side derived display state, its component metadata label, and Jest coverage. It does not modify middleware routes, Apex method contracts, job-state transitions, approval rules, org verification, Salesforce deployment behavior, or Jira communication.

Implementation of this UI does not deploy anything to a Salesforce org. Deployment remains a separate explicitly approved operation.

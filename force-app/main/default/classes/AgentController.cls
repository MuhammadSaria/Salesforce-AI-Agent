public with sharing class AgentController {
    private static final String NAMED_CREDENTIAL = 'Agent_Middleware';
    private static final Integer TIMEOUT_MS = 120000;

    @AuraEnabled
    public static String createAgentJob(String prompt, String jiraIssueKey) {
        if (String.isBlank(prompt) && String.isBlank(jiraIssueKey)) {
            throw new AuraHandledException('A user instruction or Jira issue key is required.');
        }
        if (prompt != null && prompt.length() > 8000) {
            throw new AuraHandledException('Instruction is too long. Maximum length is 8000 characters.');
        }
        Map<String, Object> payload = new Map<String, Object>{
            'prompt' => String.isBlank(prompt) ? 'Analyze Jira issue ' + jiraIssueKey.trim() : prompt.trim(),
            'jiraIssueKey' => String.isBlank(jiraIssueKey) ? null : jiraIssueKey.trim().toUpperCase(),
            'orgId' => UserInfo.getOrganizationId(),
            'context' => new Map<String, Object>()
        };
        return sendJson('POST', '/api/jobs', payload).getBody();
    }

    @AuraEnabled(cacheable=false)
    public static String getJobs() {
        return sendJson('GET', '/api/jobs', null).getBody();
    }

    @AuraEnabled(cacheable=false)
    public static String getAgentJob(String jobId) {
        return sendJson('GET', '/api/jobs/' + safePath(jobId, 'Job ID'), null).getBody();
    }

    @AuraEnabled(cacheable=false)
    public static String getOrgs() {
        return sendJson('GET', '/api/orgs', null).getBody();
    }

    @AuraEnabled
    public static String performJobAction(String jobId, String action, String payloadJson) {
        String safeAction = safePath(action, 'Action');
        Set<String> allowedActions = new Set<String>{
            'select-org', 'analyze', 'instructions', 'approve-implementation', 'reject-plan',
            'implement', 'validate', 'approve-deployment', 'reject-deployment', 'deploy', 'cancel'
        };
        if (!allowedActions.contains(safeAction)) {
            throw new AuraHandledException('Unsupported job action.');
        }
        Object payload = String.isBlank(payloadJson) ? new Map<String, Object>() : JSON.deserializeUntyped(payloadJson);
        return sendJson('POST', '/api/jobs/' + safePath(jobId, 'Job ID') + '/' + safeAction, payload).getBody();
    }

    @AuraEnabled(cacheable=false)
    public static String getJobArtifact(String jobId, String artifact) {
        String safeArtifact = safePath(artifact, 'Artifact');
        if (!new Set<String>{'plan', 'validation', 'diff', 'logs', 'audit'}.contains(safeArtifact)) {
            throw new AuraHandledException('Unsupported job artifact.');
        }
        return sendJson('GET', '/api/jobs/' + safePath(jobId, 'Job ID') + '/' + safeArtifact, null).getBody();
    }

    private static HttpResponse sendJson(String method, String path, Object payload) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint('callout:' + NAMED_CREDENTIAL + path);
        request.setMethod(method);
        request.setTimeout(TIMEOUT_MS);
        request.setHeader('Accept', 'application/json');
        request.setHeader('X-Agent-User-Id', UserInfo.getUserId());
        request.setHeader('X-Agent-Role', FeatureManagement.checkPermission('AI_Agent_Deploy') ? 'deployer' : 'developer');
        if (payload != null) {
            request.setHeader('Content-Type', 'application/json');
            request.setBody(JSON.serialize(payload));
        }
        HttpResponse response;
        try {
            response = new Http().send(request);
        } catch (Exception ex) {
            throw new AuraHandledException('Agent middleware callout failed.');
        }
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            throw new AuraHandledException(extractErrorMessage(response.getBody()));
        }
        return response;
    }

    private static String safePath(String value, String label) {
        String text = String.valueOf(value == null ? '' : value).trim();
        if (!Pattern.matches('^[A-Za-z0-9_-]{1,100}$', text)) {
            throw new AuraHandledException(label + ' is invalid.');
        }
        return EncodingUtil.urlEncode(text, 'UTF-8');
    }

    private static String extractErrorMessage(String body) {
        try {
            Map<String, Object> decoded = (Map<String, Object>) JSON.deserializeUntyped(body);
            Object errorValue = decoded.get('error');
            if (errorValue instanceof Map<String, Object>) {
                return String.valueOf(((Map<String, Object>) errorValue).get('message'));
            }
        } catch (Exception ignored) {
        }
        return 'Agent middleware returned an error.';
    }
}

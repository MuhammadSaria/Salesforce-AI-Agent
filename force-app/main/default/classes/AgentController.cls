public with sharing class AgentController {
    private static final String NAMED_CREDENTIAL = 'Agent_Middleware';
    private static final Integer TIMEOUT_MS = 120000;
    private static final Integer MAX_PROMPT_LENGTH = 8000;
    private static final Integer MAX_MESSAGE_LENGTH = 4000;
    private static final Integer MAX_COMMENT_LENGTH = 1000;

    @AuraEnabled
    public static String createJob(String prompt) {
        String safePrompt = boundedRequiredText(prompt, MAX_PROMPT_LENGTH, 'Enter a Salesforce development request.', 'Request');
        Map<String, Object> payload = new Map<String, Object>{
            'prompt' => safePrompt,
            'orgId' => UserInfo.getOrganizationId(),
            'context' => new Map<String, Object>()
        };
        return projectPermissions(sendJson('POST', '/api/jobs', payload).getBody(), false);
    }

    @AuraEnabled(cacheable=false)
    public static String getJobs() {
        return projectPermissions(sendJson('GET', '/api/jobs', null).getBody(), true);
    }

    @AuraEnabled(cacheable=false)
    public static String getJob(String jobId) {
        return projectPermissions(sendJson('GET', jobPath(jobId), null).getBody(), false);
    }

    @AuraEnabled
    public static String sendMessage(String jobId, String text) {
        String safeText = boundedRequiredText(text, MAX_MESSAGE_LENGTH, 'Enter a message.', 'Message');
        return sendJson('POST', jobPath(jobId) + '/messages', new Map<String, Object>{ 'text' => safeText }).getBody();
    }

    @AuraEnabled
    public static String performAction(String jobId, String action, String comments) {
        String safeJobPath = jobPath(jobId);
        String safeComments = boundedOptionalText(comments, MAX_COMMENT_LENGTH, 'Comments');
        Map<String, String> routes = new Map<String, String>{
            'APPROVE_IMPLEMENTATION' => 'approve-implementation',
            'REJECT_IMPLEMENTATION' => 'reject-plan',
            'APPROVE_DEPLOYMENT' => 'approve-deployment',
            'REJECT_DEPLOYMENT' => 'reject-deployment',
            'DEPLOY' => 'deploy',
            'CANCEL' => 'cancel'
        };
        String normalizedAction = String.valueOf(action == null ? '' : action).trim().toUpperCase();
        if (!routes.containsKey(normalizedAction)) {
            throw new AuraHandledException('Unsupported conversation action.');
        }

        Map<String, Object> payload = new Map<String, Object>();
        if (normalizedAction == 'APPROVE_IMPLEMENTATION' || normalizedAction == 'APPROVE_DEPLOYMENT') {
            Map<String, Object> current = currentJob(safeJobPath);
            if (normalizedAction == 'APPROVE_IMPLEMENTATION') {
                Map<String, Object> plan = mapValue(current.get('plan'));
                Map<String, Object> scope = mapValue(current.get('metadataScope'));
                Object planVersion = plan.get('planVersion');
                Object planHash = plan.get('planHash');
                Object scopeHash = scope.containsKey('hash') ? scope.get('hash') : plan.get('scopeHash');
                if (planVersion == null || String.isBlank(String.valueOf(planHash)) || String.isBlank(String.valueOf(scopeHash))) {
                    throw new AuraHandledException('The current implementation approval binding is unavailable. Refresh the conversation.');
                }
                payload.put('planVersion', planVersion);
                payload.put('planHash', planHash);
                payload.put('scopeHash', scopeHash);
            } else {
                Object validationId = mapValue(current.get('validation')).get('validationId');
                if (validationId == null || String.isBlank(String.valueOf(validationId))) {
                    throw new AuraHandledException('The current deployment validation binding is unavailable. Refresh the conversation.');
                }
                payload.put('validationId', validationId);
            }
        }
        if (!String.isBlank(safeComments)) payload.put('comments', safeComments);
        if (normalizedAction == 'CANCEL' && !String.isBlank(safeComments)) {
            payload.remove('comments');
            payload.put('reason', safeComments);
        }
        return sendJson('POST', safeJobPath + '/' + routes.get(normalizedAction), payload).getBody();
    }

    private static Map<String, Object> currentJob(String safeJobPath) {
        Object decoded = JSON.deserializeUntyped(sendJson('GET', safeJobPath, null).getBody());
        if (!(decoded instanceof Map<String, Object>)) throw new AuraHandledException('The conversation response was invalid.');
        Map<String, Object> root = (Map<String, Object>) decoded;
        return root.get('job') instanceof Map<String, Object> ? (Map<String, Object>) root.get('job') : root;
    }

    private static String projectPermissions(String body, Boolean isList) {
        try {
            Object decoded = JSON.deserializeUntyped(body);
            if (!(decoded instanceof Map<String, Object>)) return body;
            Map<String, Object> root = (Map<String, Object>) decoded;
            Boolean canImplement = FeatureManagement.checkPermission('AI_Agent_Admin');
            Boolean canDeploy = FeatureManagement.checkPermission('AI_Agent_Deploy');
            root.put('canImplement', canImplement);
            root.put('canDeploy', canDeploy);
            if (isList && root.get('jobs') instanceof List<Object>) {
                for (Object value : (List<Object>) root.get('jobs')) {
                    if (value instanceof Map<String, Object>) addPermissionProjection((Map<String, Object>) value, canImplement, canDeploy);
                }
            } else if (root.get('job') instanceof Map<String, Object>) {
                addPermissionProjection((Map<String, Object>) root.get('job'), canImplement, canDeploy);
            } else {
                addPermissionProjection(root, canImplement, canDeploy);
            }
            return JSON.serialize(root);
        } catch (Exception ignored) {
            return body;
        }
    }

    private static void addPermissionProjection(Map<String, Object> target, Boolean canImplement, Boolean canDeploy) {
        target.put('canImplement', canImplement);
        target.put('canDeploy', canDeploy);
    }

    private static HttpResponse sendJson(String method, String path, Object payload) {
        HttpRequest request = new HttpRequest();
        request.setEndpoint('callout:' + NAMED_CREDENTIAL + path);
        request.setMethod(method);
        request.setTimeout(TIMEOUT_MS);
        request.setHeader('Accept', 'application/json');
        request.setHeader('ngrok-skip-browser-warning', 'true');
        request.setHeader('X-Agent-User-Id', UserInfo.getUserId());
        request.setHeader('X-Agent-Org-Id', UserInfo.getOrganizationId());
        request.setHeader('X-Agent-Source', 'Salesforce-Apex');
        Boolean canImplement = FeatureManagement.checkPermission('AI_Agent_Admin');
        Boolean canDeploy = FeatureManagement.checkPermission('AI_Agent_Deploy');
        request.setHeader('X-Agent-Can-Implement', String.valueOf(canImplement));
        request.setHeader('X-Agent-Can-Deploy', String.valueOf(canDeploy));
        request.setHeader('X-Agent-Role', canImplement ? 'admin' : (canDeploy ? 'deployer' : 'developer'));
        if (payload != null) {
            request.setHeader('Content-Type', 'application/json');
            request.setBody(JSON.serialize(payload));
        }
        HttpResponse response;
        try {
            response = new Http().send(request);
        } catch (Exception ignored) {
            throw new AuraHandledException('Providus Nexus is temporarily unavailable.');
        }
        if (response.getStatusCode() < 200 || response.getStatusCode() >= 300) {
            throw new AuraHandledException(safeErrorForStatus(response.getStatusCode(), response.getBody()));
        }
        return response;
    }

    private static String jobPath(String jobId) {
        return '/api/jobs/' + safePath(jobId, 'Job ID');
    }

    private static String safePath(String value, String label) {
        String text = String.valueOf(value == null ? '' : value).trim();
        if (!Pattern.matches('^[A-Za-z0-9_-]{1,100}$', text)) {
            throw new AuraHandledException(label + ' is invalid.');
        }
        return EncodingUtil.urlEncode(text, 'UTF-8');
    }

    private static String boundedRequiredText(String value, Integer maximum, String blankMessage, String label) {
        String text = String.valueOf(value == null ? '' : value).trim();
        if (String.isBlank(text)) throw new AuraHandledException(blankMessage);
        if (text.length() > maximum) throw new AuraHandledException(label + ' is too long. Maximum length is ' + maximum + ' characters.');
        return text;
    }

    private static String boundedOptionalText(String value, Integer maximum, String label) {
        String text = String.valueOf(value == null ? '' : value).trim();
        if (text.length() > maximum) throw new AuraHandledException(label + ' are too long. Maximum length is ' + maximum + ' characters.');
        return text;
    }

    private static Map<String, Object> mapValue(Object value) {
        return value instanceof Map<String, Object> ? (Map<String, Object>) value : new Map<String, Object>();
    }

    @TestVisible
    private static String safeErrorForStatus(Integer statusCode, String body) {
        if (statusCode >= 500) return 'Providus Nexus is temporarily unavailable.';
        String code = '';
        try {
            Map<String, Object> decoded = (Map<String, Object>) JSON.deserializeUntyped(body);
            Object errorValue = decoded.get('error');
            if (errorValue instanceof Map<String, Object> && ((Map<String, Object>) errorValue).get('code') != null) {
                code = String.valueOf(((Map<String, Object>) errorValue).get('code')).trim().toUpperCase();
            }
        } catch (Exception ignored) {
            code = '';
        }
        if (code == 'PROMPT_REQUIRED') return 'Enter a Salesforce development request.';
        if (code == 'MESSAGE_REQUIRED') return 'Enter a message.';
        if (statusCode == 401 || code == 'UNAUTHORIZED' || code == 'SALESFORCE_CLAIMS_REQUIRED') return 'Providus Nexus authentication failed.';
        if (statusCode == 403 || code == 'FORBIDDEN') return 'This action is not permitted.';
        if (statusCode == 404) return 'Conversation not found.';
        if (statusCode == 409) return 'The conversation changed or this action is not available. Refresh and try again.';
        if (statusCode == 422) return 'The request was not accepted. Review the input and try again.';
        if (statusCode == 429) return 'Too many requests. Wait briefly and try again.';
        return 'The request could not be completed.';
    }
}

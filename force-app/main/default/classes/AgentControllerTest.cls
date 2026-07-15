@IsTest
private class AgentControllerTest {
    @IsTest static void createAgentJob_success() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(201, '{"jobId":"job-1","status":"RECEIVED"}'));
        Test.startTest(); String response = AgentController.createAgentJob('Analyze the account flow.', null); Test.stopTest();
        System.assert(response.contains('job-1'));
    }
    @IsTest static void jiraJob_success() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(201, '{"jobId":"job-2","status":"RECEIVED"}'));
        Test.startTest(); AgentController.createAgentJob(null, 'READ-42'); Test.stopTest();
    }
    @IsTest static void createAgentJob_inputGuards() {
        try { AgentController.createAgentJob(null, null); System.assert(false); }
        catch (AuraHandledException expected) { }
        String longPrompt = '';
        for (Integer i = 0; i < 8001; i++) longPrompt += 'a';
        try { AgentController.createAgentJob(longPrompt, null); System.assert(false); }
        catch (AuraHandledException expected) { }
    }
    @IsTest static void getJobAndAction_success() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(200, '{"jobId":"job-1","status":"AWAITING_PLAN_APPROVAL"}'));
        Test.startTest();
        String job = AgentController.getAgentJob('job-1');
        String action = AgentController.performJobAction('job-1', 'approve-implementation', '{"planVersion":1}');
        Test.stopTest();
        System.assert(job.contains('AWAITING_PLAN_APPROVAL')); System.assert(action.contains('job-1'));
    }
    @IsTest static void invalidAction_isBlocked() {
        try { AgentController.performJobAction('job-1', 'arbitrary-command', '{}'); System.assert(false); }
        catch (AuraHandledException expected) { System.assertNotEquals(null, expected); }
    }
    @IsTest static void invalidArtifact_isBlocked() {
        try { AgentController.getJobArtifact('job-1', 'arbitrary-command'); System.assert(false); }
        catch (AuraHandledException expected) { }
    }
    @IsTest static void getOrgs_success() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(200, '{"orgs":[{"orgRegistryId":"sapa_devsandbox"}]}'));
        Test.startTest(); String response = AgentController.getOrgs(); Test.stopTest();
        System.assert(response.contains('sapa_devsandbox'));
    }
    @IsTest static void middleware_error_isSanitized() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(500, '{"error":{"message":"Worker unavailable."}}'));
        try { AgentController.getJobs(); System.assert(false); }
        catch (AuraHandledException expected) { }
    }
    @IsTest static void middleware_topLevelError_isSanitized() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(500, '{"error":"Worker unavailable."}'));
        try { AgentController.getJobs(); System.assert(false); }
        catch (AuraHandledException expected) { }
    }
    @IsTest static void middleware_topLevelMessage_isSanitized() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(500, '{"message":"Worker unavailable."}'));
        try { AgentController.getJobs(); System.assert(false); }
        catch (AuraHandledException expected) { }
    }
    @IsTest static void middleware_rawBody_isSanitized() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(500, 'Worker unavailable.'));
        try { AgentController.getJobs(); System.assert(false); }
        catch (AuraHandledException expected) { }
    }
    private class AgentMock implements HttpCalloutMock {
        private Integer statusCode; private String body;
        public String lastEndpoint { get; private set; }
        AgentMock(Integer statusCode, String body) { this.statusCode = statusCode; this.body = body; }
        public HttpResponse respond(HttpRequest request) {
            lastEndpoint = request.getEndpoint();
            System.assert(request.getEndpoint().startsWith('callout:Agent_Middleware/api/'));
            System.assertEquals('true', request.getHeader('ngrok-skip-browser-warning'));
            System.assertNotEquals(null, request.getHeader('X-Agent-User-Id'));
            System.assertNotEquals(null, request.getHeader('X-Agent-Org-Id'));
            System.assertEquals('Salesforce-Apex', request.getHeader('X-Agent-Source'));
            System.assertNotEquals(null, request.getHeader('X-Agent-Role'));
            HttpResponse response = new HttpResponse(); response.setStatusCode(statusCode); response.setBody(body); return response;
        }
    }
}

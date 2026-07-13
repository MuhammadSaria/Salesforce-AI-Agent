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
    @IsTest static void middleware_error_isSanitized() {
        Test.setMock(HttpCalloutMock.class, new AgentMock(500, '{"error":{"message":"Worker unavailable."}}'));
        try { AgentController.getJobs(); System.assert(false); }
        catch (AuraHandledException expected) { System.assertNotEquals(null, expected); }
    }
    private class AgentMock implements HttpCalloutMock {
        private Integer statusCode; private String body;
        AgentMock(Integer statusCode, String body) { this.statusCode = statusCode; this.body = body; }
        public HttpResponse respond(HttpRequest request) {
            System.assert(request.getEndpoint().startsWith('callout:Agent_Middleware/api/'));
            System.assertNotEquals(null, request.getHeader('X-Agent-User-Id'));
            System.assertNotEquals(null, request.getHeader('X-Agent-Role'));
            HttpResponse response = new HttpResponse(); response.setStatusCode(statusCode); response.setBody(body); return response;
        }
    }
}

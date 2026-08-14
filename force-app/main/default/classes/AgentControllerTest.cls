@IsTest
private class AgentControllerTest {
    @IsTest static void createJob_postsBoundedJsonAndTrustedClaims() {
        InspectingMock mock = new InspectingMock(201, '{"jobId":"job-1","status":"RECEIVED"}');
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        String response = AgentController.createJob('Build an inactive Flow safely.');
        Test.stopTest();

        System.assert(response.contains('job-1'));
        System.assertEquals('POST', mock.requests[0].getMethod());
        System.assertEquals('callout:Agent_Middleware/api/jobs', mock.requests[0].getEndpoint());
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(mock.requests[0].getBody());
        System.assertEquals('Build an inactive Flow safely.', body.get('prompt'));
        System.assertEquals(UserInfo.getOrganizationId(), body.get('orgId'));
        assertTrustedHeaders(mock.requests[0]);
    }

    @IsTest static void createJob_rejectsBlankAndOversizedPromptBeforeCallout() {
        assertAuraFailure(new ControllerCall('createBlank'));
        assertAuraFailure(new ControllerCall('createOversized'));
    }

    @IsTest static void getJobs_getsPersistentListWithTrustedClaims() {
        InspectingMock mock = new InspectingMock(200, '{"jobs":[]}');
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest(); String response = AgentController.getJobs(); Test.stopTest();
        System.assert(response.contains('canImplement'));
        System.assertEquals('GET', mock.requests[0].getMethod());
        System.assertEquals('callout:Agent_Middleware/api/jobs', mock.requests[0].getEndpoint());
        assertTrustedHeaders(mock.requests[0]);
    }

    @IsTest static void getJob_usesSafeEncodedPathAndTrustedClaims() {
        InspectingMock mock = new InspectingMock(200, '{"jobId":"job_safe-1","status":"RECEIVED"}');
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest(); String response = AgentController.getJob('job_safe-1'); Test.stopTest();
        System.assert(response.contains('canDeploy'));
        System.assertEquals('callout:Agent_Middleware/api/jobs/job_safe-1', mock.requests[0].getEndpoint());
        assertTrustedHeaders(mock.requests[0]);
    }

    @IsTest static void getJob_rejectsUnsafePathBeforeCallout() {
        assertAuraFailure(new ControllerCall('unsafeJob'));
    }

    @IsTest static void sendMessage_postsSerializedTextAndTrustedClaims() {
        InspectingMock mock = new InspectingMock(202, '{"jobId":"job-1","messageId":"m-1"}');
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest(); AgentController.sendMessage('job-1', 'A quote: "safe"'); Test.stopTest();
        System.assertEquals('POST', mock.requests[0].getMethod());
        System.assertEquals('callout:Agent_Middleware/api/jobs/job-1/messages', mock.requests[0].getEndpoint());
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(mock.requests[0].getBody());
        System.assertEquals('A quote: "safe"', body.get('text'));
        assertTrustedHeaders(mock.requests[0]);
    }

    @IsTest static void sendMessage_rejectsBlankAndOversizedTextBeforeCallout() {
        assertAuraFailure(new ControllerCall('sendBlank'));
        assertAuraFailure(new ControllerCall('sendOversized'));
    }

    @IsTest static void performAction_allowsOnlyKnownRoutesAndBindsCurrentApproval() {
        SequenceMock mock = new SequenceMock(new List<MockResponse>{
            new MockResponse(200, '{"jobId":"job-1","status":"AWAITING_IMPLEMENTATION_APPROVAL","plan":{"planVersion":2,"planHash":"plan-hash","scopeHash":"scope-hash"},"metadataScope":{"hash":"scope-hash"}}'),
            new MockResponse(201, '{"approval":{"decision":"APPROVED"}}')
        });
        Test.setMock(HttpCalloutMock.class, mock);
        Test.startTest(); AgentController.performAction('job-1', 'APPROVE_IMPLEMENTATION', 'Reviewed.'); Test.stopTest();

        System.assertEquals(2, mock.requests.size());
        System.assertEquals('GET', mock.requests[0].getMethod());
        System.assertEquals('callout:Agent_Middleware/api/jobs/job-1', mock.requests[0].getEndpoint());
        System.assertEquals('POST', mock.requests[1].getMethod());
        System.assertEquals('callout:Agent_Middleware/api/jobs/job-1/approve-implementation', mock.requests[1].getEndpoint());
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(mock.requests[1].getBody());
        System.assertEquals(2, Integer.valueOf(String.valueOf(body.get('planVersion'))));
        System.assertEquals('plan-hash', body.get('planHash'));
        System.assertEquals('scope-hash', body.get('scopeHash'));
        System.assertEquals('Reviewed.', body.get('comments'));
    }

    @IsTest static void performAction_rejectsUnknownActionAndOversizedCommentsBeforeCallout() {
        assertAuraFailure(new ControllerCall('unknownAction'));
        assertAuraFailure(new ControllerCall('oversizedComments'));
    }

    @IsTest static void ordinaryUser_claimsDoNotGrantExecutorAuthority() {
        User userRecord = createUser('ordinary');
        insert userRecord;
        InspectingMock mock = new InspectingMock(200, '{"jobs":[]}');
        System.runAs(userRecord) {
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest(); AgentController.getJobs(); Test.stopTest();
        }
        System.assertEquals('false', mock.requests[0].getHeader('X-Agent-Can-Implement'));
        System.assertEquals('false', mock.requests[0].getHeader('X-Agent-Can-Deploy'));
    }

    @IsTest static void executor_claimsComeFromAssignedCustomPermissions() {
        PermissionSet executor = [SELECT Id FROM PermissionSet WHERE Name = 'AI_Agent_Executor' LIMIT 1];
        User userRecord = createUser('executor');
        insert userRecord;
        insert new PermissionSetAssignment(AssigneeId = userRecord.Id, PermissionSetId = executor.Id);
        InspectingMock mock = new InspectingMock(200, '{"jobs":[]}');
        System.runAs(userRecord) {
            Test.setMock(HttpCalloutMock.class, mock);
            Test.startTest(); AgentController.getJobs(); Test.stopTest();
        }
        System.assertEquals('true', mock.requests[0].getHeader('X-Agent-Can-Implement'));
        System.assertEquals('true', mock.requests[0].getHeader('X-Agent-Can-Deploy'));
    }

    @IsTest static void middlewareErrorsAreNormalized() {
        String unsafeBody = '{"error":{"code":"REQUEST_FAILED","message":"Failure at /srv/private/path with apiKey supersecret"}}';
        System.assertEquals('Providus Nexus is temporarily unavailable.', AgentController.safeErrorForStatus(500, unsafeBody));
        System.assertEquals('Enter a message.', AgentController.safeErrorForStatus(422, '{"error":{"code":"MESSAGE_REQUIRED","message":"untrusted"}}'));
        System.assertEquals('The conversation changed or this action is not available. Refresh and try again.', AgentController.safeErrorForStatus(409, unsafeBody));
        Test.setMock(HttpCalloutMock.class, new InspectingMock(500, unsafeBody));
        try { AgentController.getJobs(); System.assert(false, 'Expected a handled error.'); }
        catch (AuraHandledException expected) { System.assert(!expected.getMessage().contains('supersecret')); }
    }

    private static void assertTrustedHeaders(HttpRequest request) {
        System.assertEquals('true', request.getHeader('ngrok-skip-browser-warning'));
        System.assertEquals(UserInfo.getUserId(), request.getHeader('X-Agent-User-Id'));
        System.assertEquals(UserInfo.getOrganizationId(), request.getHeader('X-Agent-Org-Id'));
        System.assertEquals('Salesforce-Apex', request.getHeader('X-Agent-Source'));
        System.assertEquals(String.valueOf(FeatureManagement.checkPermission('AI_Agent_Admin')), request.getHeader('X-Agent-Can-Implement'));
        System.assertEquals(String.valueOf(FeatureManagement.checkPermission('AI_Agent_Deploy')), request.getHeader('X-Agent-Can-Deploy'));
    }

    private static void assertAuraFailure(ControllerCall callout) {
        try { callout.invoke(); System.assert(false, 'Expected AuraHandledException.'); }
        catch (AuraHandledException expected) { System.assertNotEquals(null, expected); }
    }

    private static User createUser(String prefix) {
        String unique = String.valueOf(DateTime.now().getTime());
        return new User(
            Alias = 'pnexec', Email = prefix + unique + '@example.invalid',
            EmailEncodingKey = 'UTF-8', LastName = 'Executor', LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US', ProfileId = UserInfo.getProfileId(),
            TimeZoneSidKey = 'America/Los_Angeles', Username = prefix + unique + '@example.invalid'
        );
    }

    private class ControllerCall {
        private String operation;
        ControllerCall(String operation) { this.operation = operation; }
        void invoke() {
            if (operation == 'createBlank') AgentController.createJob('   ');
            else if (operation == 'createOversized') AgentController.createJob(repeat('a', 8001));
            else if (operation == 'unsafeJob') AgentController.getJob('../other');
            else if (operation == 'sendBlank') AgentController.sendMessage('job-1', '  ');
            else if (operation == 'sendOversized') AgentController.sendMessage('job-1', repeat('a', 4001));
            else if (operation == 'unknownAction') AgentController.performAction('job-1', 'ARBITRARY_ROUTE', '');
            else if (operation == 'oversizedComments') AgentController.performAction('job-1', 'REJECT_IMPLEMENTATION', repeat('a', 1001));
        }
    }

    private static String repeat(String value, Integer count) {
        String output = '';
        while (output.length() < count) output += value;
        return output;
    }

    private class MockResponse {
        Integer statusCode; String body;
        MockResponse(Integer statusCode, String body) { this.statusCode = statusCode; this.body = body; }
    }

    private virtual class InspectingMock implements HttpCalloutMock {
        Integer statusCode; String body;
        List<HttpRequest> requests = new List<HttpRequest>();
        InspectingMock(Integer statusCode, String body) { this.statusCode = statusCode; this.body = body; }
        public virtual HttpResponse respond(HttpRequest request) {
            requests.add(request);
            HttpResponse response = new HttpResponse(); response.setStatusCode(statusCode); response.setBody(body); return response;
        }
    }

    private class SequenceMock extends InspectingMock {
        List<MockResponse> responses;
        SequenceMock(List<MockResponse> responses) { super(200, ''); this.responses = responses; }
        public override HttpResponse respond(HttpRequest request) {
            requests.add(request);
            MockResponse item = responses.remove(0);
            HttpResponse response = new HttpResponse(); response.setStatusCode(item.statusCode); response.setBody(item.body); return response;
        }
    }
}

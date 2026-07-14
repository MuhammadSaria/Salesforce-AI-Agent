String responseBody = AgentController.getJobs();
System.debug('AGENT_CALLOUT_OK=' + responseBody.startsWith('{"jobs"'));

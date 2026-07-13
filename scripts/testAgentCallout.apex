AgentController.AgentJobResponse response = AgentController.createAgentJob('How many accounts are in the org?');
System.debug('AGENT_JOB_ID=' + response.jobId);
System.debug('AGENT_JOB_STATUS=' + response.status);

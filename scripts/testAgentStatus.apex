AgentController.AgentJobStatusResponse response = AgentController.getAgentJobStatus('PUz7QaFJWnSiHSuAwmdMZ');
System.debug('AGENT_STATUS=' + response.status);
System.debug('AGENT_FINAL=' + response.finalAnswer);

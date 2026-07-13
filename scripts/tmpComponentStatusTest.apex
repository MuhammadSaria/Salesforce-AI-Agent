AgentController.AgentJobStatusResponse status = AgentController.getAgentJobStatus('u21bgfaPLVQwtFvnYTSDs');
System.debug('STATUS=' + status.status);
System.debug('ANSWER=' + status.finalAnswer);
System.debug('ERROR=' + status.error);

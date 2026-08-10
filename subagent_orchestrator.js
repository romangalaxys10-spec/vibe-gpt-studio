import { EventEmitter } from 'events';

export class SubAgentManager extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();
  }

  createAgent(name, role, systemPrompt) {
    const id = `agent_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
    const agent = {
      id,
      name,
      role, // 'coder' | 'tester' | 'architect' | 'reviewer' | 'security'
      systemPrompt,
      status: 'idle',
      tasks: [],
      createdAt: new Date().toISOString()
    };

    this.agents.set(id, agent);
    this.emit('agent_created', agent);
    return agent;
  }

  assignTask(agentId, taskDescription, parentSessionId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const task = {
      taskId: `task_${Date.now()}`,
      parentSessionId,
      description: taskDescription,
      status: 'running',
      output: '',
      startTime: new Date().toISOString()
    };

    agent.status = 'busy';
    agent.tasks.push(task);
    this.emit('task_assigned', { agent, task });
    return task;
  }

  completeTask(agentId, taskId, output, error = null) {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const task = agent.tasks.find(t => t.taskId === taskId);
    if (task) {
      task.status = error ? 'failed' : 'completed';
      task.output = output;
      task.error = error;
      task.endTime = new Date().toISOString();
    }

    const hasRunning = agent.tasks.some(t => t.status === 'running');
    if (!hasRunning) {
      agent.status = 'idle';
    }

    this.emit('task_completed', { agent, task });
  }

  listAgents() {
    return Array.from(this.agents.values());
  }

  getAgent(id) {
    return this.agents.get(id);
  }
}

export const subAgentManager = new SubAgentManager();

// Seed initial specialized sub-agents
subAgentManager.createAgent('Apex Coder', 'coder', 'Specialized in production code generation, bug fixing, and refactoring.');
subAgentManager.createAgent('Architect Advisor', 'architect', 'Specialized in system architecture, design patterns, and tech stack choices.');
subAgentManager.createAgent('QA Tester', 'tester', 'Specialized in unit test generation, edge case detection, and coverage.');
subAgentManager.createAgent('Security Sentinel', 'security', 'Specialized in security auditing, vulnerability scanning, and OWASP checks.');

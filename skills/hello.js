/**
 * Example OpenClaw Skill - Hello World
 * 
 * This is a simple example skill that demonstrates the basic structure
 * of an OpenClaw skill.
 */

export const skill = {
  name: 'hello',
  description: 'A simple greeting skill that says hello',
  
  /**
   * Execute the skill
   * @param {Object} context - The execution context
   * @param {string} context.message - The input message
   * @param {Object} context.user - Information about the user
   * @returns {Promise<string>} The response message
   */
  async execute(context) {
    const { message, user } = context;
    
    // Simple greeting logic
    const userName = user?.name || 'there';
    return `Hello ${userName}! You said: "${message}"`;
  }
};

export default skill;

/**
 * Action: AI Chat
 * Send any prompt to Casca. The engine classifies complexity
 * and routes to the optimal model automatically.
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: 'https://api.cascaio.com/api/zapier/chat',
    body: {
      prompt:        bundle.inputData.prompt,
      system_prompt: bundle.inputData.system_prompt || null,
      use_case:      bundle.inputData.use_case || null,
      temperature:   bundle.inputData.temperature ? parseFloat(bundle.inputData.temperature) : 0.7,
      max_tokens:    bundle.inputData.max_tokens ? parseInt(bundle.inputData.max_tokens, 10) : 2048,
    },
  });
  return response.data;
};

const sample = {
  id: 'casca-sample-001',
  content: 'The refund policy allows returns within 30 days of purchase with a valid receipt.',
  model: 'gpt-4o-mini',
  classification: 'LOW',
  tokens_used: 85,
  cost_usd: 0.0000127,
  savings_pct: 85,
  cache_hit: false,
  latency_ms: 1100,
};

module.exports = {
  key: 'ai_chat',
  noun: 'AI Response',
  display: {
    label: 'AI Chat',
    description: 'Send a prompt to Casca AI. Automatically routed to the best model at the lowest cost.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'prompt',
        label: 'Prompt',
        type: 'text',
        required: true,
        helpText: 'The message to send to AI. Casca will classify its complexity and route to the optimal model.',
      },
      {
        key: 'system_prompt',
        label: 'System Prompt',
        type: 'text',
        required: false,
        helpText: 'Optional instructions for the AI. Example: "You are a customer service agent. Be concise."',
      },
      {
        key: 'use_case',
        label: 'Use Case Hint',
        type: 'string',
        required: false,
        choices: ['GENERAL', 'CASE_SUMMARY', 'SOQL_GEN', 'TRANSLATION', 'CODE_GEN', 'FIELD_ENRICH'],
        helpText: 'Helps Casca classify more accurately. Leave blank for auto-detect.',
      },
      {
        key: 'temperature',
        label: 'Temperature',
        type: 'string',
        required: false,
        default: '0.7',
        helpText: 'Creativity level: 0.0 (deterministic) to 2.0 (creative). Default: 0.7',
      },
      {
        key: 'max_tokens',
        label: 'Max Tokens',
        type: 'string',
        required: false,
        default: '2048',
        helpText: 'Maximum response length in tokens. Default: 2048',
      },
    ],
    sample,
    outputFields: [
      { key: 'id',             label: 'Request ID',     type: 'string'  },
      { key: 'content',        label: 'AI Response',    type: 'string'  },
      { key: 'model',          label: 'Model Used',     type: 'string'  },
      { key: 'classification', label: 'Classification', type: 'string'  },
      { key: 'tokens_used',    label: 'Tokens Used',    type: 'integer' },
      { key: 'cost_usd',       label: 'Cost (USD)',     type: 'number'  },
      { key: 'savings_pct',    label: 'Savings %',      type: 'integer' },
      { key: 'cache_hit',      label: 'Cache Hit',      type: 'boolean' },
      { key: 'latency_ms',     label: 'Latency (ms)',   type: 'integer' },
    ],
  },
};

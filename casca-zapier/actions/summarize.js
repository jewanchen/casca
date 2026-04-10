/**
 * Action: Summarize Text
 * Summarize any text into bullet points using AI.
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: 'https://api.cascaio.com/api/zapier/summarize',
    body: {
      text:          bundle.inputData.text,
      language:      bundle.inputData.language || 'English',
      bullet_points: bundle.inputData.bullet_points ? parseInt(bundle.inputData.bullet_points, 10) : 5,
    },
  });
  return response.data;
};

module.exports = {
  key: 'summarize',
  noun: 'Summary',
  display: {
    label: 'Summarize Text',
    description: 'Summarize any text into concise bullet points using AI.',
    important: true,
  },
  operation: {
    perform,
    inputFields: [
      { key: 'text', label: 'Text to Summarize', type: 'text', required: true, helpText: 'Paste the text you want summarized.' },
      { key: 'language', label: 'Output Language', type: 'string', required: false, default: 'English', helpText: 'Language for the summary. Default: English' },
      { key: 'bullet_points', label: 'Number of Bullet Points', type: 'string', required: false, default: '5', helpText: 'How many bullet points. Default: 5' },
    ],
    sample: {
      id: 'casca-sum-001',
      content: '• Key point one\n• Key point two\n• Key point three',
      model: 'gpt-4o-mini',
      classification: 'LOW',
      tokens_used: 120,
      cost_usd: 0.000018,
      savings_pct: 90,
      cache_hit: false,
      latency_ms: 900,
    },
    outputFields: [
      { key: 'content', label: 'Summary', type: 'string' },
      { key: 'model', label: 'Model Used', type: 'string' },
      { key: 'tokens_used', label: 'Tokens Used', type: 'integer' },
      { key: 'cost_usd', label: 'Cost (USD)', type: 'number' },
    ],
  },
};

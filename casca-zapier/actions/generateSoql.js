/**
 * Action: Generate SOQL
 * Convert natural language to Salesforce SOQL query.
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: 'https://api.cascaio.com/api/zapier/generate-soql',
    body: {
      query:   bundle.inputData.query,
      objects: bundle.inputData.objects || '',
    },
  });
  return response.data;
};

module.exports = {
  key: 'generate_soql',
  noun: 'SOQL Query',
  display: {
    label: 'Generate SOQL Query',
    description: 'Convert a natural language question into a Salesforce SOQL query.',
  },
  operation: {
    perform,
    inputFields: [
      { key: 'query', label: 'Question', type: 'text', required: true,
        helpText: 'Describe what data you want in plain language. Example: "Find all open high-priority cases from last week"' },
      { key: 'objects', label: 'Available Objects', type: 'string', required: false,
        helpText: 'Comma-separated Salesforce objects to query. Example: "Case, Account, Contact"' },
    ],
    sample: {
      id: 'casca-soql-001',
      content: "SELECT Id, Subject, Priority FROM Case WHERE Status = 'Open' AND Priority = 'High' AND CreatedDate = THIS_WEEK",
      model: 'gpt-4o-mini',
      classification: 'MED',
      tokens_used: 95,
      cost_usd: 0.0000142,
      savings_pct: 85,
      cache_hit: false,
      latency_ms: 1300,
    },
    outputFields: [
      { key: 'content', label: 'SOQL Query', type: 'string' },
      { key: 'model', label: 'Model Used', type: 'string' },
      { key: 'tokens_used', label: 'Tokens Used', type: 'integer' },
    ],
  },
};

/**
 * Action: Extract Structured Data
 *
 * Pulls named fields out of any unstructured text (emails, contracts, forms,
 * support tickets, etc.) and returns a parsed JSON object. Casca automatically
 * routes extraction requests to a high-capability model while keeping costs low
 * through intelligent routing.
 *
 * Endpoint: POST /api/zapier/extract
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: 'https://api.cascaio.com/api/zapier/extract',
    body: {
      text:               bundle.inputData.text,
      schema_description: bundle.inputData.schema_description,
      example_output:     bundle.inputData.example_output || null,
    },
  });
  return response.data;
};

const sample = {
  id: 'casca-extract-001',
  content: '{"name":"Acme Corp","contact":"jane@acme.com","budget":"$50,000","timeline":"Q3 2025"}',
  extracted: {
    name:     'Acme Corp',
    contact:  'jane@acme.com',
    budget:   '$50,000',
    timeline: 'Q3 2025',
  },
  model:          'gpt-4o',
  classification: 'HIGH',
  tokens_used:    420,
  cost_usd:       0.0021,
  savings_pct:    40,
  cache_hit:      false,
  latency_ms:     1800,
};

module.exports = {
  key:  'extract_data',
  noun: 'Extracted Data',

  display: {
    label:       'Extract Structured Data',
    description: 'Pull specific fields from any unstructured text — emails, contracts, support tickets, forms. Returns a structured JSON object you can map to any other Zap step.',
    important:   true,
  },

  operation: {
    perform,

    inputFields: [
      {
        key:      'text',
        label:    'Text to Extract From',
        type:     'text',
        required: true,
        helpText: 'The raw text you want to extract data from. Can be an email body, contract clause, form submission, or any unstructured content.',
      },
      {
        key:      'schema_description',
        label:    'Fields to Extract',
        type:     'text',
        required: true,
        helpText:
          'Describe the fields you want, one per line. Examples:\n' +
          '- name: the person\'s full name\n' +
          '- company: company or organisation name\n' +
          '- budget: the budget amount mentioned\n' +
          '- email: contact email address',
      },
      {
        key:      'example_output',
        label:    'Example JSON Output (optional)',
        type:     'text',
        required: false,
        helpText:
          'Provide a JSON example to pin the exact output shape. E.g.:\n' +
          '{"name": "John Smith", "company": "Acme", "budget": "$10,000"}\n' +
          'Leave blank to let Casca infer the format.',
      },
    ],

    sample,

    outputFields: [
      { key: 'id',             label: 'Request ID',      type: 'string'  },
      { key: 'content',        label: 'Raw JSON String', type: 'string'  },
      // Flattened extracted fields surfaced by Zapier's dynamic output
      { key: 'extracted__name',     label: 'Extracted: name'     },
      { key: 'extracted__company',  label: 'Extracted: company'  },
      { key: 'extracted__email',    label: 'Extracted: email'    },
      { key: 'extracted__budget',   label: 'Extracted: budget'   },
      { key: 'model',          label: 'Model Used',      type: 'string'  },
      { key: 'classification', label: 'Classification',  type: 'string'  },
      { key: 'tokens_used',    label: 'Tokens Used',     type: 'integer' },
      { key: 'cost_usd',       label: 'Cost (USD)',      type: 'number'  },
      { key: 'savings_pct',    label: 'Savings %',       type: 'integer' },
      { key: 'cache_hit',      label: 'Cache Hit',       type: 'boolean' },
      { key: 'latency_ms',     label: 'Latency (ms)',    type: 'integer' },
    ],
  },
};

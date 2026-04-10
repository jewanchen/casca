/**
 * Action: Classify Text
 *
 * Assigns one (or more) labels from a user-defined list to any text input.
 * Typical uses: route support tickets, score leads, tag content, triage emails.
 * Uses temperature 0 for deterministic, cost-efficient classification.
 *
 * Endpoint: POST /api/zapier/classify
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: 'https://api.cascaio.com/api/zapier/classify',
    body: {
      text:        bundle.inputData.text,
      categories:  bundle.inputData.categories,
      multi_label: bundle.inputData.multi_label === 'true',
    },
  });
  return response.data;
};

const sample = {
  id:             'casca-classify-001',
  content:        'refund',
  category:       'refund',
  model:          'gpt-4o-mini',
  classification: 'LOW',
  tokens_used:    55,
  cost_usd:       0.0000082,
  savings_pct:    92,
  cache_hit:      false,
  latency_ms:     620,
};

module.exports = {
  key:  'classify_text',
  noun: 'Classification',

  display: {
    label:       'Classify Text',
    description: 'Classify any text into your own custom categories. Use it to route support tickets, score inbound leads, tag content, or triage emails — no training required.',
    important:   true,
  },

  operation: {
    perform,

    inputFields: [
      {
        key:      'text',
        label:    'Text to Classify',
        type:     'text',
        required: true,
        helpText: 'The text you want classified. Can be an email, message, note, or any free-form content.',
      },
      {
        key:      'categories',
        label:    'Categories',
        type:     'string',
        required: true,
        helpText:
          'Comma-separated list of possible labels. Examples:\n' +
          'refund, technical issue, billing, general inquiry\n' +
          'hot lead, warm lead, cold lead\n' +
          'urgent, normal, low priority',
      },
      {
        key:      'multi_label',
        label:    'Allow Multiple Labels',
        type:     'string',
        required: false,
        default:  'false',
        choices:  ['false', 'true'],
        helpText: 'Set to true to allow the AI to return multiple matching categories separated by commas. Default: false (single label only).',
      },
    ],

    sample,

    outputFields: [
      { key: 'id',             label: 'Request ID',     type: 'string'  },
      { key: 'category',       label: 'Category',       type: 'string'  },
      { key: 'content',        label: 'Raw Output',     type: 'string'  },
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

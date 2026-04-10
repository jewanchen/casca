/**
 * Trigger: New API Log
 * Fires when a new API request is processed through Casca.
 * Polling-based (Zapier polls every 1-15 min).
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    url: 'https://api.cascaio.com/api/zapier/logs',
    params: { limit: 25 },
  });
  return response.data;
};

const sample = {
  id: 'log-sample-001',
  prompt_hash: 'a1b2c3d4e5f6...',
  cx: 'LOW',
  model_name: 'gpt-4o-mini',
  tokens_in: 42,
  tokens_out: 128,
  cost_usd: 0.000025,
  savings_pct: 85,
  is_cache_hit: false,
  latency_ms: 1200,
  status_code: 200,
  created_at: '2026-04-02T10:00:00Z',
};

module.exports = {
  key: 'new_api_log',
  noun: 'API Log',
  display: {
    label: 'New API Request',
    description: 'Triggers when a new AI request is processed through Casca.',
  },
  operation: {
    perform,
    sample,
    outputFields: [
      { key: 'id',           label: 'Log ID',         type: 'string'   },
      { key: 'cx',           label: 'Classification', type: 'string'   },
      { key: 'model_name',   label: 'Model Used',     type: 'string'   },
      { key: 'tokens_in',    label: 'Input Tokens',   type: 'integer'  },
      { key: 'tokens_out',   label: 'Output Tokens',  type: 'integer'  },
      { key: 'cost_usd',     label: 'Cost (USD)',     type: 'number'   },
      { key: 'savings_pct',  label: 'Savings %',      type: 'integer'  },
      { key: 'is_cache_hit', label: 'Cache Hit',      type: 'boolean'  },
      { key: 'latency_ms',   label: 'Latency (ms)',   type: 'integer'  },
      { key: 'status_code',  label: 'HTTP Status',    type: 'integer'  },
      { key: 'created_at',   label: 'Created At',     type: 'datetime' },
    ],
  },
};

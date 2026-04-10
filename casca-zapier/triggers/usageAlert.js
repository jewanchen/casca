/**
 * Trigger: Usage Alert
 * Fires when token usage exceeds 80% of plan quota.
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    url: 'https://api.cascaio.com/api/zapier/usage',
  });
  return response.data;
};

const sample = {
  id: 'usage-abc123-2026-04-02',
  email: 'user@company.com',
  plan: 'Starter',
  used_tokens: 8500000,
  included_tokens: 10000000,
  usage_pct: 85,
  balance_credits: 25.50,
  alert_level: 'WARNING',
  date: '2026-04-02',
};

module.exports = {
  key: 'usage_alert',
  noun: 'Usage Alert',
  display: {
    label: 'Usage Quota Alert',
    description: 'Triggers when your AI token usage exceeds 80% of your plan quota.',
  },
  operation: {
    perform,
    sample,
    outputFields: [
      { key: 'id',              label: 'Alert ID',        type: 'string'  },
      { key: 'email',           label: 'Account Email',   type: 'string'  },
      { key: 'plan',            label: 'Plan',            type: 'string'  },
      { key: 'used_tokens',     label: 'Tokens Used',     type: 'integer' },
      { key: 'included_tokens', label: 'Tokens Included', type: 'integer' },
      { key: 'usage_pct',       label: 'Usage %',         type: 'integer' },
      { key: 'balance_credits', label: 'Balance (USD)',   type: 'number'  },
      { key: 'alert_level',     label: 'Alert Level',     type: 'string'  },
      { key: 'date',            label: 'Date',            type: 'string'  },
    ],
  },
};

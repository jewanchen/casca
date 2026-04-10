const perform = async (z, bundle) => {
  const response = await z.request({ url: 'https://api.cascaio.com/api/dashboard/me' });
  const d = response.data;
  return [{
    id: d.id, email: d.email, company_name: d.company_name,
    plan_name: d.plan_name || 'Free',
    balance_credits: d.balance_credits || 0,
    cycle_used_tokens: d.cycle_used_tokens || 0,
    included_m_tokens: d.included_m_tokens || 0,
  }];
};

module.exports = {
  key: 'find_usage',
  noun: 'Usage Stats',
  display: {
    label: 'Find Usage Stats',
    description: 'Look up your current plan, token usage, and balance.',
  },
  operation: {
    perform,
    inputFields: [
      {
        key: 'email',
        label: 'Account Email',
        type: 'string',
        required: false,
        helpText: 'Your Casca account email. Leave blank to use the authenticated account.',
      },
    ],
    sample: {
      id: 'user-001',
      email: 'user@company.com',
      plan_name: 'Starter',
      balance_credits: 45,
      cycle_used_tokens: 5200000,
      included_m_tokens: 10,
    },
    outputFields: [
      { key: 'id',                 label: 'Account ID',    type: 'string'  },
      { key: 'email',              label: 'Email',         type: 'string'  },
      { key: 'plan_name',          label: 'Plan',          type: 'string'  },
      { key: 'balance_credits',    label: 'Balance (USD)', type: 'number'  },
      { key: 'cycle_used_tokens',  label: 'Tokens Used',   type: 'integer' },
      { key: 'included_m_tokens',  label: 'Included (M)',  type: 'number'  },
    ],
  },
};

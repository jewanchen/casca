/**
 * Authentication — API Key (csk_...)
 *
 * Users enter their Casca API key. Zapier verifies it by calling
 * /api/zapier/auth-test and uses the response to label the connection.
 */

const test = async (z, bundle) => {
  const response = await z.request({
    url: 'https://api.cascaio.com/api/zapier/auth-test',
  });
  if (response.status !== 200) {
    throw new z.errors.Error(
      'Invalid API Key. Get your key at cascaio.com/dashboard',
      'AuthenticationError',
      response.status
    );
  }
  return response.data;
};

module.exports = {
  type: 'custom',
  test,
  connectionLabel: '{{email}} ({{plan}})',
  fields: [
    {
      key: 'api_key',
      label: 'API Key',
      type: 'string',
      required: true,
      helpText: 'Your Casca API key (starts with `csk_`). Find it at [cascaio.com/dashboard](https://cascaio.com/dashboard) → API Keys.',
    },
  ],
};

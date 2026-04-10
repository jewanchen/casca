/**
 * Action: Translate Text
 * Translate any text to a target language using AI.
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    method: 'POST',
    url: 'https://api.cascaio.com/api/zapier/translate',
    body: {
      text:            bundle.inputData.text,
      target_language: bundle.inputData.target_language,
    },
  });
  return response.data;
};

module.exports = {
  key: 'translate',
  noun: 'Translation',
  display: {
    label: 'Translate Text',
    description: 'Translate any text to another language using AI.',
  },
  operation: {
    perform,
    inputFields: [
      { key: 'text', label: 'Text to Translate', type: 'text', required: true },
      { key: 'target_language', label: 'Target Language', type: 'string', required: true,
        choices: ['English', '繁體中文', '简体中文', '日本語', '한국어', 'Español', 'Français', 'Deutsch', 'Português', 'Italiano', 'ภาษาไทย', 'Tiếng Việt', 'Bahasa Indonesia'],
        helpText: 'The language to translate to.' },
    ],
    sample: {
      id: 'casca-tr-001',
      content: 'This is the translated text.',
      model: 'gemini-2.0-flash',
      classification: 'LOW',
      tokens_used: 60,
      cost_usd: 0.000006,
      savings_pct: 94,
      cache_hit: false,
      latency_ms: 700,
    },
    outputFields: [
      { key: 'content', label: 'Translated Text', type: 'string' },
      { key: 'model', label: 'Model Used', type: 'string' },
      { key: 'tokens_used', label: 'Tokens Used', type: 'integer' },
      { key: 'cost_usd', label: 'Cost (USD)', type: 'number' },
    ],
  },
};

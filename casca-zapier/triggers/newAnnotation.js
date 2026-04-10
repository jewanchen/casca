/**
 * Trigger: New Annotation
 * Fires when a new ambiguous prompt needs human labeling.
 */

const perform = async (z, bundle) => {
  const response = await z.request({
    url: 'https://api.cascaio.com/api/zapier/annotations',
  });
  return response.data;
};

const sample = {
  id: 'annot-sample-001',
  prompt: 'What is the company policy on remote work?',
  predicted_cx: 'MED',
  triggered_rule: 'AMBIG_HR_POLICY',
  lang: 'en',
  uc: 'HR',
  status: 'pending',
  created_at: '2026-04-02T10:00:00Z',
};

module.exports = {
  key: 'new_annotation',
  noun: 'Annotation',
  display: {
    label: 'New Annotation Needed',
    description: 'Triggers when an ambiguous prompt needs human review in the annotation queue.',
  },
  operation: {
    perform,
    sample,
    outputFields: [
      { key: 'id', label: 'Annotation ID', type: 'string' },
      { key: 'prompt', label: 'Prompt Text', type: 'string' },
      { key: 'predicted_cx', label: 'Predicted Classification', type: 'string' },
      { key: 'triggered_rule', label: 'Rule', type: 'string' },
      { key: 'lang', label: 'Language', type: 'string' },
      { key: 'uc', label: 'Use Case', type: 'string' },
      { key: 'created_at', label: 'Created At', type: 'datetime' },
    ],
  },
};

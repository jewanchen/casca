/**
 * Casca AI Router — Zapier Integration
 *
 * Triggers:  New API Log, New Annotation, Usage Alert
 * Actions:   AI Chat, Summarize, Translate, Generate SOQL,
 *            Extract Structured Data, Classify Text
 * Searches:  Find Usage Stats
 *
 * @version 1.0.2
 */

const authentication = require('./authentication');
const newApiLog = require('./triggers/newApiLog');
const newAnnotation = require('./triggers/newAnnotation');
const usageAlert = require('./triggers/usageAlert');
const aiChat = require('./actions/aiChat');
const summarize = require('./actions/summarize');
const translate = require('./actions/translate');
const generateSoql = require('./actions/generateSoql');
const extractData = require('./actions/extractData');
const classifyText = require('./actions/classifyText');
const findUsage = require('./searches/findUsage');

module.exports = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,

  authentication,

  // ── Before each request: inject Authorization header ──
  beforeRequest: [
    (request, z, bundle) => {
      request.headers.Authorization = `Bearer ${bundle.authData.api_key}`;
      return request;
    },
  ],

  triggers: {
    [newApiLog.key]:     newApiLog,
    [newAnnotation.key]: newAnnotation,
    [usageAlert.key]:    usageAlert,
  },

  creates: {
    [aiChat.key]:       aiChat,
    [summarize.key]:    summarize,
    [translate.key]:    translate,
    [generateSoql.key]: generateSoql,
    [extractData.key]:  extractData,
    [classifyText.key]: classifyText,
  },

  searches: {
    [findUsage.key]: findUsage,
  },
};

const zapier = require('zapier-platform-core');
const App = require('../index');
const appTester = zapier.createAppTester(App);
zapier.tools.env.inject();

describe('Auth', () => {
  it('should have correct auth type', () => {
    expect(App.authentication.type).toBe('custom');
  });
  it('should have api_key field', () => {
    expect(App.authentication.fields[0].key).toBe('api_key');
  });
  it('should have connection label', () => {
    expect(App.authentication.connectionLabel).toBeDefined();
  });
});

describe('Structure', () => {
  it('should have 3 triggers', () => {
    expect(Object.keys(App.triggers)).toHaveLength(3);
  });
  it('should have 4 actions', () => {
    expect(Object.keys(App.actions)).toHaveLength(4);
  });
  it('should have 1 search', () => {
    expect(Object.keys(App.searches)).toHaveLength(1);
  });
  it('should have beforeRequest hook', () => {
    expect(App.beforeRequest).toHaveLength(1);
  });
});

describe('Triggers have required fields', () => {
  Object.entries(App.triggers).forEach(([key, trigger]) => {
    it(`${key} should have key, noun, display, operation`, () => {
      expect(trigger.key).toBeDefined();
      expect(trigger.noun).toBeDefined();
      expect(trigger.display.label).toBeDefined();
      expect(trigger.operation.perform).toBeDefined();
      expect(trigger.operation.sample).toBeDefined();
    });
  });
});

describe('Actions have required fields', () => {
  Object.entries(App.actions).forEach(([key, action]) => {
    it(`${key} should have key, noun, display, operation`, () => {
      expect(action.key).toBeDefined();
      expect(action.noun).toBeDefined();
      expect(action.display.label).toBeDefined();
      expect(action.operation.perform).toBeDefined();
      expect(action.operation.sample).toBeDefined();
      expect(action.operation.inputFields).toBeDefined();
    });
  });
});

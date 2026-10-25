import test from 'node:test';
import assert from 'node:assert/strict';
import { captionLang } from '../../src/driver.js';
test('captionLang: auto default, bare codes widen, bad input refused', () => {
  assert.equal(captionLang(), 'auto');
  assert.equal(captionLang('AUTO'), 'auto');
  assert.equal(captionLang('ru'), 'ru-RU');
  assert.equal(captionLang('es'), 'es-ES');
  assert.equal(captionLang('pt-br'), 'pt-BR');
  assert.equal(captionLang('nl'), 'nl');
  assert.throws(() => captionLang('ru;drop'));
});

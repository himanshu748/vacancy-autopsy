import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicOrigin } from '../src/server/hosting.js';

const renderWeb = { RENDER: 'true', RENDER_SERVICE_TYPE: 'web', RENDER_EXTERNAL_URL: 'https://vacancy-autopsy-example.onrender.com' };

test('Render web startup uses the actual provider hostname without guessing its allocated slug', () => {
  assert.equal(resolvePublicOrigin(renderWeb), renderWeb.RENDER_EXTERNAL_URL);
  assert.equal(resolvePublicOrigin({ ...renderWeb, RENDER_EXTERNAL_URL: `${renderWeb.RENDER_EXTERNAL_URL}/` }), renderWeb.RENDER_EXTERNAL_URL);
});

test('Local and non-web environments do not infer a hosted origin from unrelated metadata', () => {
  assert.equal(resolvePublicOrigin({ RENDER_EXTERNAL_URL: renderWeb.RENDER_EXTERNAL_URL }), undefined);
  assert.equal(resolvePublicOrigin({ ...renderWeb, RENDER: 'false' }), undefined);
  assert.equal(resolvePublicOrigin({ ...renderWeb, RENDER_SERVICE_TYPE: 'pserv' }), undefined);
  assert.equal(resolvePublicOrigin({ ...renderWeb, RENDER_EXTERNAL_URL: '' }), undefined);
});

test('Explicit public origin takes precedence for a deliberately configured custom domain', () => {
  assert.equal(resolvePublicOrigin({ ...renderWeb, PUBLIC_ORIGIN: 'https://jobs.example.com/' }), 'https://jobs.example.com');
});

test('Automatic and explicit origins refuse credentials, private addresses, paths, queries and fragments', () => {
  for (const value of ['http://jobs.example.com', 'https://127.0.0.1', 'https://user:secret@jobs.example.com',
    'https://jobs.example.com/api', 'https://jobs.example.com/?x=1', 'https://jobs.example.com/#fragment']) {
    assert.throws(() => resolvePublicOrigin({ PUBLIC_ORIGIN: value }));
    assert.throws(() => resolvePublicOrigin({ ...renderWeb, RENDER_EXTERNAL_URL: value }));
  }
  for (const value of ['https://jobs.example.com', 'https://vacancy.onrender.com.attacker.example', 'https://vacancy.onrender.com:4430']) {
    assert.throws(() => resolvePublicOrigin({ ...renderWeb, RENDER_EXTERNAL_URL: value }));
  }
});

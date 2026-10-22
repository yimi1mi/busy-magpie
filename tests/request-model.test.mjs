import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redactDiagnostic} from '../web/request-model.mjs';
test('copied diagnostics remove credentials and account names',()=>{
  const text=redactDiagnostic('Bearer secret-value user@example.com sk-test-123 token=abcd');
  for(const secret of ['secret-value','user@example.com','sk-test-123','abcd'])assert(!text.includes(secret));
  assert(!redactDiagnostic('https://user:pass@example.org/test').includes('user:pass'));
});

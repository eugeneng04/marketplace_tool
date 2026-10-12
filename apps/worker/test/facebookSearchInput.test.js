import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFacebookSearchInput} from '../src/server.js';

test('HTTP search input preserves an explicit document-only search source', () => {
  const body = {query:'frs',latitude:37.4,longitude:-121.9,searchSource:'marketplace_search_page'};
  assert.equal(parseFacebookSearchInput(body).searchSource,'marketplace_search_page');
  assert.equal(parseFacebookSearchInput({...body,searchSource:undefined}).searchSource,undefined);
});

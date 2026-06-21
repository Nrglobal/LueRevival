const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrateSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrate.js'), 'utf8');

test('migration board seed is safe for existing persistent databases', () => {
  assert.doesNotMatch(migrateSource, /INSERT\s+INTO\s+boards\s*\(\s*id\s*,/i, 'board seeds must not hardcode primary keys');
  assert.match(migrateSource, /INSERT\s+INTO\s+boards\s*\(\s*title\s*,\s*description\s*,\s*sort_order\s*\)/i);
  assert.match(migrateSource, /ON\s+CONFLICT\s*\(\s*title\s*\)\s+DO\s+UPDATE\s+SET/i);
  assert.match(migrateSource, /SELECT\s+id\s+FROM\s+boards\s+WHERE\s+title=\$1\s+LIMIT\s+1/i, 'welcome topic must look up LUE board id');
  assert.doesNotMatch(migrateSource, /INSERT\s+INTO\s+topics\s*\([^)]*board_id[^)]*\)[\s\S]*VALUES\s*\(\s*1\s*,/i, 'welcome topic must not hardcode board_id=1');
});

test('migration tag seed is safe for existing persistent databases', () => {
  assert.doesNotMatch(migrateSource, /INSERT\s+INTO\s+topical_tags\s*\(\s*id\s*,/i, 'tag seeds must not hardcode primary keys');
  assert.match(migrateSource, /SELECT\s+id\s+FROM\s+topical_tags\s+WHERE\s+title=\$1\s+LIMIT\s+1/i, 'welcome tag mapping must look up LUE tag id');
  assert.doesNotMatch(migrateSource, /INSERT\s+INTO\s+tagged[\s\S]*VALUES\s*\(\s*\$1\s*,\s*1\s*,/i, 'tagged seed must not hardcode tag_id=1');
});

test('migration synchronizes serial sequences after legacy explicit id seeds', () => {
  assert.match(migrateSource, /async\s+function\s+syncSerial/);
  assert.match(migrateSource, /syncSerial\(client, 'boards'\)/);
  assert.match(migrateSource, /syncSerial\(client, 'topical_tags'\)/);
});

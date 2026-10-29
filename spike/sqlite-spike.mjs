// SQLite binding spike: proves the guarantees DECIDE relies on (06 §2, §8, §10) on this platform.
// Run: node spike/sqlite-spike.mjs   (exit 0 = all checks passed)
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = mkdtempSync(join(tmpdir(), 'decide-spike-'));
const file = join(dir, 'spike.db');
const a = new DatabaseSync(file);
const b = new DatabaseSync(file);
const results = [];
const check = (name, fn) => { fn(); results.push(name); };

a.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;
  CREATE TABLE receipts(operation_id TEXT PRIMARY KEY, effect TEXT NOT NULL);
  CREATE TABLE world(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);
  CREATE TABLE audit(seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
  CREATE TABLE evidence(id TEXT PRIMARY KEY, source_class TEXT NOT NULL CHECK(source_class <> 'HYPOTHETICAL'));
  INSERT INTO world VALUES (1, 100);`);
b.exec('PRAGMA busy_timeout=200;');

check('UNIQUE operation id blocks duplicate effect', () => {
  a.prepare('INSERT INTO receipts VALUES (?,?)').run('op-1', 'paid');
  assert.throws(() => a.prepare('INSERT INTO receipts VALUES (?,?)').run('op-1', 'paid'), /UNIQUE/);
});

check('rollback undoes effect + audit together', () => {
  a.exec('BEGIN IMMEDIATE');
  a.prepare('UPDATE world SET balance = balance - 40 WHERE id = 1').run();
  a.prepare('INSERT INTO audit(body) VALUES (?)').run('effect');
  a.exec('ROLLBACK');
  assert.equal(a.prepare('SELECT balance FROM world').get().balance, 100);
  assert.equal(a.prepare('SELECT count(*) n FROM audit').get().n, 0);
});

check('BEGIN IMMEDIATE serializes a second writer (SQLITE_BUSY)', () => {
  a.exec('BEGIN IMMEDIATE');
  assert.throws(() => b.exec('BEGIN IMMEDIATE'), /locked|busy/i);
  a.exec('COMMIT');
  b.exec('BEGIN IMMEDIATE'); b.exec('COMMIT');
});

check('triggers make audit append-only', () => {
  a.prepare('INSERT INTO audit(body) VALUES (?)').run('e1');
  assert.throws(() => a.exec("UPDATE audit SET body='x'"), /append-only/);
  assert.throws(() => a.exec('DELETE FROM audit'), /append-only/);
});

check('CHECK rejects HYPOTHETICAL evidence rows', () => {
  assert.throws(() => a.prepare('INSERT INTO evidence VALUES (?,?)').run('h1', 'HYPOTHETICAL'), /CHECK/);
});

check('committed data survives reopen', () => {
  a.close(); b.close();
  const c = new DatabaseSync(file);
  assert.equal(c.prepare('SELECT effect FROM receipts WHERE operation_id=?').get('op-1').effect, 'paid');
  assert.equal(c.prepare('SELECT count(*) n FROM audit').get().n, 1);
  c.close();
});

rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ platform: platform(), node: process.version, sqlite: 'node:sqlite', passed: results }, null, 1));

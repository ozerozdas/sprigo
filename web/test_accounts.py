"""Regression tests for isolated, server-backed web accounts."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

from accounts import Accounts, AccountError


class AccountsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.accounts = Accounts(Path(self.tmp.name))

    def test_accounts_are_isolated_and_passwordless_login_is_explicit(self):
        first_token = self.accounts.register('first', '1234')
        second_token = self.accounts.register('second', '')
        first = self.accounts.session(first_token)[0]
        second = self.accounts.session(second_token)[0]
        self.accounts.sql(first, 'execute', 'CREATE TABLE notes(message TEXT)', [])
        self.accounts.sql(first, 'execute', 'INSERT INTO notes(message) VALUES (?)', ['private'])
        self.assertEqual(self.accounts.sql(first, 'select', 'SELECT message FROM notes', []), [{'message': 'private'}])
        self.assertEqual(self.accounts.sql(second, 'select', 'SELECT name FROM sqlite_master WHERE name = ?', ['notes']), [])
        self.assertGreaterEqual(self.accounts.revision(first), 2)
        with self.assertRaises(AccountError):
            self.accounts.login('first', 'wrong')
        self.assertEqual(self.accounts.session(self.accounts.login('second', ''))[0], second)
        self.accounts.logout(first_token)
        self.assertIsNone(self.accounts.session(first_token))

    def test_import_and_sqlite_attach_protection(self):
        imported = Path(self.tmp.name) / 'import.sqlite3'
        with sqlite3.connect(imported) as db:
            db.execute('CREATE TABLE profiles(id INTEGER PRIMARY KEY, name TEXT)')
            db.execute('INSERT INTO profiles(name) VALUES (?)', ('Learner',))
        token = self.accounts.register('learner', 'pass', imported.read_bytes())
        account = self.accounts.session(token)[0]
        self.assertEqual(self.accounts.sql(account, 'select', 'SELECT name FROM profiles', []), [{'name': 'Learner'}])
        with self.assertRaises((AccountError, sqlite3.DatabaseError)):
            self.accounts.sql(account, 'execute', "ATTACH DATABASE '/tmp/other.sqlite3' AS other", [])
        with self.assertRaises(AccountError):
            self.accounts.register('invalid', '123', None)


if __name__ == '__main__':
    unittest.main()

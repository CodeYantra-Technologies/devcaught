import unittest

from policy import allowed_file, excluded


class ClosedGuardPolicyTests(unittest.TestCase):
    def test_reviewed_non_build_paths_are_excluded_exactly(self):
        paths = (
            'src/lib/inbox/PRIVATE_INBOX_ROUTING.md',
            'src/lib/og/site.json',
            'apps/server/src/smtp/PRIVATE_ROUTING.md',
            'apps/server/src/store/schema.sql',
        )
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(excluded(path))
                self.assertFalse(allowed_file(path))

    def test_ordinary_approved_inputs_remain_accepted(self):
        paths = (
            'package.json',
            'src/lib/inbox/private-inbox-routing.server.ts',
            'apps/server/src/smtp/receiver.ts',
            'migrations/0004_private_inbox_routing.sql',
        )
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(allowed_file(path))

    def test_unrelated_json_sql_and_markdown_are_not_broadly_allowed(self):
        paths = (
            'src/lib/og/other.json',
            'apps/server/src/store/other.sql',
            'src/lib/inbox/OTHER.md',
            'migrations/nested/0005_extra.sql',
        )
        for path in paths:
            with self.subTest(path=path):
                self.assertFalse(allowed_file(path))


if __name__ == '__main__':
    unittest.main()

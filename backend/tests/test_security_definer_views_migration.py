from pathlib import Path
import re
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG_PATH = REPO_ROOT / "supabase" / "migrations" / "20261205_fix_security_definer_views.sql"
UNDO_PATH = REPO_ROOT / "supabase" / "rollbacks" / "20261205_fix_security_definer_views_UNDO.sql"


class SecurityDefinerViewsMigrationAuditTests(unittest.TestCase):
    def test_proconfig_regex_matches_postgres_empty_search_path_representations(self):
        sql = MIG_PATH.read_text(encoding="utf-8")
        match = re.search(r"WHERE\s+cfg\s*~\s*'([^']+)'", sql)
        self.assertIsNotNone(match, "Audit block must use regex check on pg_proc.proconfig")
        pattern = re.compile(match.group(1))

        # PostgreSQL stores SET search_path = '' in proconfig as search_path="" (or search_path=)
        self.assertIsNotNone(pattern.match('search_path=""'))
        self.assertIsNotNone(pattern.match("search_path="))

        # Unsafe or unrelated GUC configs must be rejected
        for bad_cfg in (
            "search_path=public",
            'search_path="public"',
            'search_path=""public',
            "search_path=public,pg_temp",
            "statement_timeout=5000",
            "",
        ):
            self.assertIsNone(pattern.match(bad_cfg), msg=f"Should reject {bad_cfg!r}")

    def test_migration_is_atomic_idempotent_and_preserves_security_design(self):
        self.assertTrue(MIG_PATH.exists())
        self.assertTrue(UNDO_PATH.exists())

        sql = MIG_PATH.read_text(encoding="utf-8")
        undo_sql = UNDO_PATH.read_text(encoding="utf-8")

        # Single atomic transaction guarantees nothing is half-applied on RAISE EXCEPTION
        self.assertRegex(sql, r"(?m)^BEGIN;\s*$")
        self.assertRegex(sql, r"(?m)^COMMIT;\s*$")
        self.assertRegex(undo_sql, r"(?m)^BEGIN;\s*$")
        self.assertRegex(undo_sql, r"(?m)^COMMIT;\s*$")

        # Re-runnable idempotent DDL only
        self.assertIn("CREATE OR REPLACE FUNCTION public.get_visible_complaint_history()", sql)
        self.assertIn("CREATE OR REPLACE VIEW public.public_complaint_history", sql)
        self.assertIn("WITH (security_barrier = TRUE, security_invoker = TRUE)", sql)
        self.assertIn("ALTER VIEW public.public_officers SET (security_barrier = TRUE, security_invoker = TRUE);", sql)
        self.assertIn("ALTER VIEW public.public_complaints SET (security_barrier = TRUE, security_invoker = TRUE);", sql)

        # Security design preserved: SECURITY DEFINER + SET search_path = '' + no internal_note/actor_id exposed
        fn_block = sql.split("CREATE OR REPLACE FUNCTION public.get_visible_complaint_history()", 1)[1].split("$$;", 1)[0]
        self.assertIn("SECURITY DEFINER", fn_block)
        self.assertIn("SET search_path = ''", fn_block)
        self.assertNotIn("internal_note", fn_block)
        self.assertNotIn("actor_id", fn_block)
        self.assertNotIn("h.notes", fn_block)

        # No anon access on any of the 3 views or function
        self.assertIn("REVOKE ALL ON public.public_officers FROM PUBLIC, anon;", sql)
        self.assertIn("REVOKE ALL ON public.public_complaints FROM PUBLIC, anon;", sql)
        self.assertIn("REVOKE ALL ON public.public_complaint_history FROM PUBLIC, anon;", sql)
        self.assertIn("REVOKE ALL ON FUNCTION public.get_visible_complaint_history() FROM PUBLIC, anon;", sql)


if __name__ == "__main__":
    unittest.main()

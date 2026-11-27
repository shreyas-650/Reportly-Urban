from pathlib import Path
import re
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
MIG_PATH = REPO_ROOT / "supabase" / "migrations" / "20261213_india_geospatial_bounds.sql"
UNDO_PATH = REPO_ROOT / "supabase" / "rollbacks" / "20261213_india_geospatial_bounds_UNDO.sql"


class IndiaGeospatialMigrationTests(unittest.TestCase):
    def test_migration_and_rollback_exist_and_are_atomic(self):
        self.assertTrue(MIG_PATH.exists(), f"Missing migration: {MIG_PATH}")
        self.assertTrue(UNDO_PATH.exists(), f"Missing rollback: {UNDO_PATH}")

        sql = MIG_PATH.read_text(encoding="utf-8")
        undo_sql = UNDO_PATH.read_text(encoding="utf-8")

        self.assertRegex(sql, r"(?m)^BEGIN;\s*$")
        self.assertRegex(sql, r"(?m)^COMMIT;\s*$")
        self.assertRegex(undo_sql, r"(?m)^BEGIN;\s*$")
        self.assertRegex(undo_sql, r"(?m)^COMMIT;\s*$")

    def test_trigger_design_matches_approved_amendments(self):
        sql = MIG_PATH.read_text(encoding="utf-8")

        # Decision 1: additive BEFORE INSERT OR UPDATE OF latitude, longitude trigger; no CHECK NOT VALID
        self.assertIn("CREATE TRIGGER trg_guard_complaints_india_bounds", sql)
        self.assertIn(
            "BEFORE INSERT OR UPDATE OF latitude, longitude ON public.complaints",
            sql,
        )
        self.assertNotIn("NOT VALID", sql.upper())

        # Security and Postgres hygiene
        fn_block = sql.split("CREATE OR REPLACE FUNCTION public.guard_complaints_india_bounds()", 1)[1].split("$$;", 1)[0]
        self.assertIn("SECURITY DEFINER", fn_block)
        self.assertIn("SET search_path = ''", fn_block)
        self.assertNotRegex(fn_block, r"\bRECORD\b")
        self.assertNotIn("pg_catalog.coalesce", fn_block.lower())
        self.assertIn("ALTER FUNCTION public.guard_complaints_india_bounds() OWNER TO postgres;", sql)
        self.assertIn(
            "REVOKE ALL ON FUNCTION public.guard_complaints_india_bounds() FROM PUBLIC, anon, authenticated;",
            sql,
        )

        # Amendment A: fires for every role (no role bypass), skips unchanged coordinates on UPDATE,
        # allows both NULL, rejects solitary NULL or out-of-box coordinates.
        self.assertNotIn("auth.role", fn_block.lower())
        self.assertNotIn("service_role", fn_block.lower())
        self.assertIn("IF TG_OP = 'UPDATE' THEN", fn_block)
        self.assertIn("NEW.latitude IS NOT DISTINCT FROM OLD.latitude", fn_block)
        self.assertIn("NEW.longitude IS NOT DISTINCT FROM OLD.longitude", fn_block)
        self.assertIn("IF NEW.latitude IS NULL AND NEW.longitude IS NULL THEN", fn_block)

        # India bounds matching frontend + Amendment B error code and marker
        self.assertIn("6.0", fn_block)
        self.assertIn("37.6", fn_block)
        self.assertIn("68.0", fn_block)
        self.assertIn("97.6", fn_block)
        self.assertIn("INDIA_BOUNDS_VIOLATION", fn_block)
        self.assertIn("ERRCODE = '22023'", fn_block)

        # Undo script cleanly drops trigger and function
        undo_sql = UNDO_PATH.read_text(encoding="utf-8")
        self.assertIn("DROP TRIGGER IF EXISTS trg_guard_complaints_india_bounds ON public.complaints;", undo_sql)
        self.assertIn("DROP FUNCTION IF EXISTS public.guard_complaints_india_bounds();", undo_sql)


if __name__ == "__main__":
    unittest.main()

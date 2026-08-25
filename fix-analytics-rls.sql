-- Fix analytics upserts and keep analytics private.
-- This script does not delete or modify any analytics row.

-- The app uses upsert(..., { onConflict: 'session_id' }). PostgreSQL requires
-- a unique constraint/index on that exact column for ON CONFLICT to work.
-- This check stops safely if prior data has duplicate session IDs; review those
-- rows before deciding how to consolidate them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.visitor_analytics
    GROUP BY session_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate session_id values exist. No rows were changed; review them before adding the unique index.';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS visitor_analytics_session_id_unique
ON public.visitor_analytics (session_id);

-- The Node server must use the service-role key in Render. Do not expose it in
-- browser code. With a service-role key, server requests bypass RLS.
ALTER TABLE public.visitor_analytics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow public inserts" ON public.visitor_analytics;
DROP POLICY IF EXISTS "Public read access" ON public.visitor_analytics;

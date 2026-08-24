-- Fix visitor_analytics RLS policy
-- This migration removes the permissive "Allow public inserts" policy
-- and restricts inserts to only the service role (server-side)

-- 1. Drop the existing permissive policy
DROP POLICY IF EXISTS "Allow public inserts" ON public.visitor_analytics;

-- 2. Create a policy that only allows service_role to insert
-- (service_role is used by your Node.js server with SUPABASE_KEY)
CREATE POLICY "Server-side inserts only"
ON public.visitor_analytics
FOR INSERT
TO service_role
WITH CHECK (true);

-- 3. Optional: Allow public to view analytics (if you want a public dashboard)
-- Remove this if analytics should be admin-only
CREATE POLICY "Public read access"
ON public.visitor_analytics
FOR SELECT
TO anon, authenticated
USING (true);

-- 4. Make sure RLS is enabled
ALTER TABLE public.visitor_analytics ENABLE ROW LEVEL SECURITY;

-- 5. Add index on session_id for upsert performance (if not already exists)
CREATE INDEX IF NOT EXISTS idx_visitor_analytics_session_id
ON public.visitor_analytics(session_id);

-- Note: Your server should use the SUPABASE_SERVICE_ROLE_KEY (not anon key)
-- for analytics inserts. Update your environment variables:
-- SUPABASE_KEY=<your-service-role-key>

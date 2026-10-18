-- Let the database API discover the new tables. The anonymous role is
-- allowed to ask for them, but row-level security has no anonymous policies,
-- so an anonymous request returns nothing at all.
GRANT SELECT ON public.isolates TO anon;
GRANT SELECT ON public.alerts TO anon;
GRANT SELECT ON public.user_roles TO anon;
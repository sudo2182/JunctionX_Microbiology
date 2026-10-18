-- Remove app-role access to the signup trigger (the auth service and
-- maintenance roles keep it) and drop the helper that only existed to read
-- GraphQL metadata.
revoke execute on function public.handle_new_user() from authenticated;
drop function if exists public.isolate_overview(uuid);
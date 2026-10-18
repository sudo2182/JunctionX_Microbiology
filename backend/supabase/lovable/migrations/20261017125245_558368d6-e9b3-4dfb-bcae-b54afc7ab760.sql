-- Refresh the database API's table cache so the new isolate, alert and
-- staff-role tables become reachable.
NOTIFY pgrst, 'reload schema';
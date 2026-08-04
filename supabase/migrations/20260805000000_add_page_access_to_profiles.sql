-- # Per-user page access overrides
--
-- Adds profiles.page_access: a nullable text array of page ids the user is
-- allowed to open. When NULL (the default), the user's role decides their
-- pages (see ROLE_ACCESS in src/lib/access.ts). Admins can set per-user
-- overrides from the Admin page so individual users can be granted or denied
-- pages without changing their role.
--
-- Valid page ids (enforced in the admin-users edge function):
--   calculator, tracker, live, downtime, analytics, saved-records
-- The Admin page itself is always admin-only and is never stored here.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS page_access text[];

-- # Add Manager and Team Lead roles
--
-- Extends the profiles.role check constraint so the app can assign four roles:
--   operator  — Live, Calculator, Downtime
--   team_lead — Live, Monitoring, Downtime, Calculator
--   manager   — Live, Monitoring, Downtime, Calculator, Analytics
--   admin     — all pages
--
-- Page access is enforced in the frontend; the admin-users edge function only
-- allows the values listed here.

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'manager', 'team_lead', 'operator'));

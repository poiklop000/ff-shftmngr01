-- # Profiles table for app user management
--
-- The app uses name + password login (usernames are mapped to Supabase Auth
-- email addresses as "<username>@app.local"). Each auth user gets one row here
-- with their display name, role, and active flag.
--
-- - `user_id`     uuid, primary key, references auth.users(id) on delete cascade
-- - `username`    text, unique — the login name
-- - `display_name` text — shown name (e.g. "Kelvin")
-- - `role`        text — 'admin' or 'operator'
-- - `is_active`   bool — disabled users cannot sign in
--
-- RLS: users can read/update only their own profile. The admin-users edge
-- function uses the service role, which bypasses RLS.

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id       uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  role          text NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own_profile_select" ON public.profiles;
CREATE POLICY "own_profile_select" ON public.profiles
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "own_profile_update" ON public.profiles;
CREATE POLICY "own_profile_update" ON public.profiles
  FOR UPDATE USING (auth.uid() = user_id);

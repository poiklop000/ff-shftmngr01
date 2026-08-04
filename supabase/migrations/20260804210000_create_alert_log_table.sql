-- # Alert history table
--
-- Records every Teams alert the teams-downtime-alert edge function sends, so
-- admins can review what was delivered (and any failures) from the web app.
--
-- Writes come from the edge function (service role, bypasses RLS). Reads are
-- allowed for admins through the web app (authenticated role).

CREATE TABLE IF NOT EXISTS public.alert_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_type   text NOT NULL,              -- 'occurred' | 'resolved' | 'escalation' | 'recurring' | 'test'
  event_id     bigint,
  reason       text,
  category     text,
  product      text,
  message      text,
  status       text NOT NULL DEFAULT 'sent', -- 'sent' | 'failed'
  http_status  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_log_created_at ON public.alert_log (created_at DESC);

ALTER TABLE public.alert_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_select_alert_log" ON public.alert_log;
CREATE POLICY "admin_select_alert_log" ON public.alert_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- Allow pausing a broadcast mid-send. The drip endpoint
-- (/api/broadcasts/drip) only ever processes status='sending', so
-- flipping a campaign to 'paused' is sufficient to stop it being drained;
-- flipping it back to 'sending' resumes it on the next cron tick.
alter table broadcasts drop constraint broadcasts_status_check;
alter table broadcasts add constraint broadcasts_status_check
  check (status in ('draft', 'scheduled', 'sending', 'sent', 'failed', 'paused'));

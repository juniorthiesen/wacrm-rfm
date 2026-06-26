-- Denormalize the sent template's buttons onto the message row so the
-- inbox can show "this message had buttons" without a join, and so the
-- record stays accurate even if the template is later edited/deleted.
-- Populated by /api/whatsapp/send, the automations engine, and the
-- broadcast drip — all three resolve the template's `buttons` JSONB at
-- send time and copy it here.
alter table messages add column if not exists template_buttons jsonb;

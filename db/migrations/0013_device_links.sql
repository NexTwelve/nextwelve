-- 0013_device_links: read-only access from a phone, paired by QR code.
--
-- A signed-in user shows a QR code (a one-time pairing secret, valid two minutes). The phone that
-- scans it claims the link and is shown a two-digit number; the user types that number on the
-- computer to approve, so a code photographed by someone else is useless. The phone then gets a
-- read-only session tied to this row: every request from it checks that the link is still
-- active (require_device_link), and the user can revoke it at any time.
--
--   status: pending (QR shown) -> claimed (a phone scanned it) -> approved (number matched)
--           -> active (the phone collected its session) -> revoked; or denied / expired.
-- Secrets are stored only as SHA-256 hashes.

create table epm.device_link (
  link_id            uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references epm.tenant on delete cascade,
  user_id            uuid not null references epm.app_user on delete cascade,
  code_hash          bytea not null,
  code_expires_at    timestamptz not null,
  claim_hash         bytea,
  match_code         text check (match_code ~ '^[0-9]{2}$'),
  match_attempts     int not null default 0,
  status             text not null default 'pending'
                     check (status in ('pending', 'claimed', 'approved', 'active', 'denied', 'revoked', 'expired')),
  device_label       text check (length(device_label) <= 120),
  created_at         timestamptz not null default now(),
  claimed_at         timestamptz,
  approved_at        timestamptz,
  activated_at       timestamptz,
  session_expires_at timestamptz,
  revoked_at         timestamptz
);
create index device_link_user on epm.device_link (tenant_id, user_id, created_at desc);

alter table epm.device_link enable row level security;
alter table epm.device_link force row level security;
create policy tenant_isolation on epm.device_link
  using (tenant_id = epm.current_tenant())
  with check (tenant_id = epm.current_tenant());
grant select, insert, update on epm.device_link to epm_app;

-- Run at the start of every request from a phone (in the same round trip as the session check).
create function epm.require_device_link(p_link uuid) returns void
  language plpgsql stable
  as $$
begin
  if not exists (select 1 from epm.device_link l
                  where l.link_id = p_link and l.user_id = epm.current_app_user() and l.status = 'active'
                    and l.session_expires_at > now()) then
    raise exception 'this phone''s access has ended; scan a new code on your computer' using errcode = 'NX401';
  end if;
end $$;
grant execute on function epm.require_device_link(uuid) to epm_app;

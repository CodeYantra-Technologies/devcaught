-- Registry only. No message backfill, routing activation or application grants.
CREATE TABLE smtp_inbox_route (
  destination text PRIMARY KEY CHECK (
    length(destination) <= 254 AND destination = lower(trim(destination))
    AND destination ~ '^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
    AND destination NOT LIKE '%..%' AND destination NOT LIKE '%.@%'
  ),
  inbox_id text NOT NULL REFERENCES private_inbox(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE sms_inbox_route (
  provider text NOT NULL CHECK (provider IN ('twilio', 'msg91')),
  provider_account_id text NOT NULL CHECK (
    provider_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
  ),
  destination text NOT NULL CHECK (destination ~ '^\+[1-9][0-9]{1,14}$'),
  inbox_id text NOT NULL REFERENCES private_inbox(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (provider, provider_account_id, destination),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

-- Tombstones reserve destinations permanently, including after revocation.
-- SECURITY INVOKER: no privileged database execution surface is introduced.
CREATE FUNCTION enforce_immutable_inbox_route() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Routing assignments cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'state' - 'revoked_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'state' - 'revoked_at') THEN
    RAISE EXCEPTION 'Routing assignments are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state = 'revoked' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Revoked assignments are permanent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER smtp_inbox_route_immutable BEFORE UPDATE OR DELETE ON smtp_inbox_route
FOR EACH ROW EXECUTE FUNCTION enforce_immutable_inbox_route();
CREATE TRIGGER sms_inbox_route_immutable BEFORE UPDATE OR DELETE ON sms_inbox_route
FOR EACH ROW EXECUTE FUNCTION enforce_immutable_inbox_route();

-- Parent ownership is immutable even before the first route is inserted.
-- This also closes a race between route provisioning and parent reassignment.
CREATE FUNCTION protect_routed_inbox_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'Private inbox ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER private_inbox_routed_owner_immutable BEFORE UPDATE ON private_inbox
FOR EACH ROW EXECUTE FUNCTION protect_routed_inbox_owner();

REVOKE ALL ON smtp_inbox_route, sms_inbox_route FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_immutable_inbox_route() FROM PUBLIC;
REVOKE ALL ON FUNCTION protect_routed_inbox_owner() FROM PUBLIC;

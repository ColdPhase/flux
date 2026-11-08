-- #990: sign-in throttling that every API process shares. Before, Better Auth counted attempts per address in each process's memory, so a second
-- API process doubled the rate, a restart cleared it, and nothing limited the guesses against one account.
-- auth_rate_limits: Better Auth's own limiter, switched to its database storage (key = address|path; last_request in milliseconds).
-- auth_sign_in_throttle: wrong passwords per account, keyed by a hash of the lower-cased address (see schema.ts).
-- Flux has no installations or data yet (founder, 2026-10-31): nothing is converted.
CREATE TABLE public.auth_rate_limits (
    id text PRIMARY KEY,
    key text NOT NULL UNIQUE,
    count integer NOT NULL,
    last_request bigint NOT NULL
);

CREATE TABLE public.auth_sign_in_throttle (
    account_hash text PRIMARY KEY,
    failures integer NOT NULL,
    last_failure_at timestamp with time zone NOT NULL,
    locked_until timestamp with time zone
);
CREATE INDEX auth_sign_in_throttle_last_failure_idx ON public.auth_sign_in_throttle (last_failure_at);

-- F-024 S4 revision (#314, founder direction 2026-10-09): the provider session id (`sid`) the stored offline
-- refresh token was issued for. Flux revokes a replaced token only when no live browser session carries this
-- sid: Keycloak's revocation also removes Flux from that sid's online session, which would silently stop the
-- session's back-channel logout. Null for a token whose provider sent no sid (it is then never revoked).
-- Sparse after 0073 (0074-0076 belong to other branches).
ALTER TABLE auth_idp_standing ADD COLUMN refresh_token_sid text CHECK (refresh_token_sid IS NULL OR length(refresh_token_sid) BETWEEN 1 AND 512);

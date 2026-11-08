-- Confirmation links are also limited per address, whichever account asks for them (#1056): three accounts could each send a stranger a link.
-- The key is a SHA-256 of the lower-cased address, so no readable address is stored. Flux has no installs yet, so nothing is converted.
CREATE TABLE public.notification_address_sends (
    address_hash text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    sent integer NOT NULL,
    last_sent_at timestamp with time zone NOT NULL
);
ALTER TABLE ONLY public.notification_address_sends
    ADD CONSTRAINT notification_address_sends_pkey PRIMARY KEY (address_hash);
CREATE INDEX notification_address_sends_last_idx ON public.notification_address_sends USING btree (last_sent_at);

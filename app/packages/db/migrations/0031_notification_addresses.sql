-- Several notification addresses, each with its own switch (#872, C-49): a person keeps up to five extra addresses beside the
-- sign-in address, each confirmed by its own link and switched on or off; the sign-in address has a switch in the preferences.
-- A notification email is queued once for each address that is switched on. Flux has no installs yet, so nothing is converted.
ALTER TABLE public.notification_addresses
  DROP CONSTRAINT notification_addresses_user_id_key,
  ADD COLUMN enabled boolean DEFAULT true NOT NULL;
CREATE UNIQUE INDEX notification_addresses_user_email_idx ON public.notification_addresses USING btree (user_id, lower(email));
CREATE INDEX notification_addresses_user_created_idx ON public.notification_addresses USING btree (user_id, created_at);

ALTER TABLE public.notification_preferences
  ADD COLUMN account_enabled boolean DEFAULT true NOT NULL;

-- The copy for an extra address names that address; it stays as a record when the address is removed.
ALTER TABLE public.notification_emails
  DROP CONSTRAINT notification_emails_notification_id_address_kind_key,
  ADD COLUMN address_id uuid;
ALTER TABLE ONLY public.notification_emails
  ADD CONSTRAINT notification_emails_address_id_fkey FOREIGN KEY (address_id) REFERENCES public.notification_addresses(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX notification_emails_account_idx ON public.notification_emails USING btree (notification_id) WHERE (address_kind = 'account');
CREATE UNIQUE INDEX notification_emails_extra_idx ON public.notification_emails USING btree (notification_id, address_id) WHERE (address_kind = 'extra' AND address_id IS NOT NULL);

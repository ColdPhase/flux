-- #1441: only models that call tools can be agents, decided by one check. When a key is added (and when another model of its list is chosen
-- for an agent) the server sends the provider one small request on that model with one tool, `ping`, and asks the model to call it. This
-- table records each check: the model that was checked, what the request cost (it is charged to the key's day like any request, CA-3) and
-- whether the model called the tool. A key + model with a row that has `calls_tools` is not checked again.
-- Works on data left by v0.2.0: a new table, nothing to convert; keys and agents made before it are checked the first time one of them
-- chooses another model.
CREATE TABLE public.api_key_checks (
    id uuid NOT NULL,
    connection_id uuid NOT NULL,
    model text NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    charged_micros bigint NOT NULL,
    calls_tools boolean NOT NULL,
    CONSTRAINT api_key_checks_pkey PRIMARY KEY (id),
    CONSTRAINT api_key_checks_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES public.background_compute_connections(id) ON DELETE CASCADE,
    CONSTRAINT api_key_checks_charged_micros_check CHECK (charged_micros >= 0),
    CONSTRAINT api_key_checks_model_check CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$')
);
CREATE INDEX api_key_checks_connection_idx ON public.api_key_checks USING btree (connection_id, checked_at);

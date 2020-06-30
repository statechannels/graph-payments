import * as Knex from 'knex';

// Before you can run this migration, you must run `yarn db:create_schema'.
// Ensure that the `PAYMENT_MANAGER_CONNECTION string is correctly defined in your shell, or
// supply it as a shell arg.
const SCHEMA = 'payment_manager';
const TABLE = `${SCHEMA}.payment_channels`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
  CREATE TABLE ${TABLE}
  (
    "channel_id" TEXT NOT NULL PRIMARY KEY,
    "context_id" TEXT NOT NULL,
    "turn_number" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "payer_balance" TEXT NOT NULL,
    "receiver_balance" TEXT NOT NULL,
    "outcome" JSONB NOT NULL,
    "app_data" TEXT NOT NULL,
    "retired" BOOLEAN NOT NULL DEFAULT false
  );

  /*
  I think this index will be just about optimal for the query planner: the critical query needs to:
  - filter out all the rows based on the context
  - filter out all the rows based on the context
  We might want to come of with a better, bigger index once we have real data and evidence that the query
  is slow
  */
  CREATE INDEX channel_lookup_idx ON ${TABLE}
    (context_id, turn_number);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE ${TABLE}`);
}

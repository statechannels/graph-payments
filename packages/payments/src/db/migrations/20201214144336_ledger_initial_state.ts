import * as Knex from 'knex';

const SCHEMA = 'payment_manager';
const TABLE = `ledger_channels`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema(SCHEMA).alterTable(TABLE, function (table) {
    table.jsonb('initial_outcome').notNullable().defaultTo(JSON.stringify([]));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema(SCHEMA).alterTable(TABLE, function (table) {
    table.dropColumn('initial_outcome');
  });
}

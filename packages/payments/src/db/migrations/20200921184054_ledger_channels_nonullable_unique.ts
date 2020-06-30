import * as Knex from 'knex';

const SCHEMA = 'payment_manager';
const TABLE = `ledger_channels`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema(SCHEMA).alterTable(TABLE, function (table) {
    table.string('channel_id').notNullable().unique().alter();
    table.string('context_id').notNullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.withSchema(SCHEMA).alterTable(TABLE, function (table) {
    table.dropUnique(['channel_id']);
    table.string('channel_id').nullable().alter();
    table.string('context_id').nullable().alter();
  });
}

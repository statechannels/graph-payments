import * as Knex from 'knex';

const SCHEMA = 'payment_manager';
const TABLE = `ledger_channels`;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.withSchema(SCHEMA).createTable(TABLE, function (table) {
    table.string('channel_id');
    table.string('context_id');
    table.index('context_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE);
}

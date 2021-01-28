import path from 'path';

import {DatabaseConnectionConfiguration} from '@statechannels/server-wallet';
import Knex, {Config} from 'knex';

import {SCHEMA} from './constants';

const BASE_PATH = path.join(__dirname);
const extensions = [path.extname(__filename)];

export function createKnex(connection: DatabaseConnectionConfiguration): Knex {
  const config: Config = {
    client: 'pg',
    connection,
    migrations: {
      directory: path.join(BASE_PATH, 'migrations'),
      loadExtensions: extensions,
      schemaName: SCHEMA
    }
  };
  return Knex(config);
}

export async function migrateCacheDB(knex: Knex): Promise<void> {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS payment_manager');
  await knex.migrate.latest();
}

import {DatabaseConnectionConfiguration} from '@statechannels/server-wallet';
import Knex, {Config} from 'knex';
import path from 'path';
import {SCHEMA} from './constants';

const BASE_PATH = path.join(__dirname, 'db');
const extensions = [path.extname(__filename)];

export function getKnex(connection: DatabaseConnectionConfiguration): Knex {
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

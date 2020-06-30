import * as path from 'path';

import Knex, {Config} from 'knex';

import {CONNECTION_STRING, SCHEMA} from './db/constants';

const BASE_PATH = path.join(__dirname, 'db');
const extensions = [path.extname(__filename)];

export const knexConfig: Config = {
  client: 'pg',
  connection: CONNECTION_STRING,
  migrations: {
    directory: path.join(BASE_PATH, 'migrations'),
    loadExtensions: extensions,
    schemaName: SCHEMA
  }
};

export const knex = Knex(knexConfig);

export const {client, connection, migrations} = knexConfig;

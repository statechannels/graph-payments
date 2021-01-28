import * as path from 'path';
import Knex, {Config} from 'knex';
import yargs from 'yargs';
import {SCHEMA} from '../src/db/constants';
import {parse} from 'pg-connection-string';
async function dbScripts() {
  try {
    yargs
      .command(
        'migrate [dbConnection]',
        'Migrate the database',
        (args) => args.positional('dbConnection', {type: 'string', required: true}),
        ({dbConnection}) => handleDBCommand('migrate', dbConnection).then(process.exit(0))
      )
      .command(
        'create_schema [dbConnection]',
        'Creates necessesary database schema',
        (args) => args.positional('dbConnection', {type: 'string', required: true}),
        ({dbConnection}) => handleDBCommand('create_schema', dbConnection).then(process.exit(0))
      )
      .help().argv;
  } catch (error) {
    console.error('Error occured migrating', error);
    process.exit(1);
  }
}

async function handleDBCommand(
  command: 'migrate' | 'create_schema',
  dbConnection: string | undefined
) {
  try {
    if (!dbConnection) {
      throw new Error('No db connection provided');
    }

    const BASE_PATH = path.join(__dirname, '../src/db');
    const extensions = [path.extname(__filename)];
    const parsedDbConnection = parse(dbConnection);
    console.log(`Using db connection ${JSON.stringify(parsedDbConnection)}`);
    const {host, port, user, database, password} = parsedDbConnection;
    if (!database) {
      throw new Error('No database provided');
    }
    const knexConfig: Config = {
      client: 'pg',
      connection: {
        ...parsedDbConnection,
        // This is annoying but pg-connection-string returns null and undefined values
        host: host || 'localhost',
        port: port ? Number(port) : 5432,
        user: user || 'postgres',
        password: password || undefined,
        database: database || undefined
      },
      migrations: {
        directory: path.join(BASE_PATH, 'migrations'),
        loadExtensions: extensions,
        schemaName: SCHEMA
      }
    };

    const knex = Knex(knexConfig);
    console.log('Creating schema if needed');
    await knex.raw('CREATE SCHEMA IF NOT EXISTS payment_manager');
    if (command === 'migrate') {
      console.log('Running cache migrations');
      await knex.migrate.latest();
    }
  } catch (error) {
    console.error('Error occured', error);
    process.exit(1);
  }
}
dbScripts();

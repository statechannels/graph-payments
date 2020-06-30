import {exec, ChildProcess} from 'child_process';
import waitOn from 'wait-on';
import kill from 'tree-kill';
import * as path from 'path';
import {
  PAYER_SERVER_URL,
  RECEIPT_SERVER_URL,
  RECEIPT_SERVER_DB_NAME,
  PAYER_SERVER_DB_NAME
} from './constants';

import {Logger} from 'pino';

class ExternalServer {
  private serverProcess: ChildProcess | undefined = undefined;
  public get pid() {
    return this.serverProcess?.pid;
  }
  public constructor(
    private name: string,
    private command: string,
    private dbName: string,
    private endpoint: string
  ) {}

  public async start(logger: Logger, skipEvmValidation = false): Promise<void> {
    const cmd = `
      PAYMENT_MANAGER_CONNECTION='postgresql://postgres@localhost/${this.dbName}' \
      SERVER_DB_NAME=${this.dbName} \
      SKIP_EVM_VALIDATION=${skipEvmValidation} \
      SERVER_DB_USER=postgres \
      AMOUNT_OF_WORKER_THREADS=${process.env.AMOUNT_OF_WORKER_THREADS} \
      ${this.command}
    `;

    logger.info(cmd);

    this.serverProcess = exec(cmd, {
      // todo: in theory, this should not be needed as the default value for env is process.env...
      env: process.env
    });

    this.serverProcess.stdout?.on('data', (d) => logger.info(`${this.name} - ${d}`));
    this.serverProcess.stderr?.on('data', (d) => logger.error(`${this.name} - ${d}`));
    this.serverProcess.on('error', (err) => {
      throw err;
    });
    return waitOn({resources: [this.endpoint]});
  }

  public async stop(signal = 'SIGINT'): Promise<number | null> {
    return new Promise((resolve, reject) => {
      if (typeof this.serverProcess === 'undefined') reject('Process not started');
      else {
        this.serverProcess.on('exit', resolve);
        kill(this.serverProcess.pid, signal);
      }
    });
  }
}

export function createPaymentServer(opts: string[] = []): ExternalServer {
  const script = path.join(__dirname, '../src/payment-server.ts');
  return new ExternalServer(
    'PaymentServer',
    `yarn ts-node ${script} listen ${opts?.join(' ')}`,
    PAYER_SERVER_DB_NAME,
    PAYER_SERVER_URL
  );
}

export function createReceiptServer(opts: string[] = []): ExternalServer {
  return new ExternalServer(
    'ReceiptServer',
    `yarn ts-node ${path.join(__dirname, 'receipt-server.ts')} listen ${opts.join(' ')}`,
    RECEIPT_SERVER_DB_NAME,
    RECEIPT_SERVER_URL
  );
}

export function createFlameGraphPaymentServer(
  opts: string[] = ['--ensureAllocations false']
): ExternalServer {
  const script = path.join(__dirname, '../lib/src/payment-server.js');
  return new ExternalServer(
    'PaymentServer',
    `npx clinic flame -- node ${script} listen ${opts.join(' ')}`,
    PAYER_SERVER_DB_NAME,
    PAYER_SERVER_URL
  );
}

export function createFlameGraphReceiptServer(opts: string[] = []): ExternalServer {
  const scriptPath = path.join(__dirname, '../lib/src/receipt-server.js');
  return new ExternalServer(
    'ReceiptServer',
    `npx clinic flame  -- node ${scriptPath} listen ${opts.join(' ')}`,
    RECEIPT_SERVER_DB_NAME,
    RECEIPT_SERVER_URL
  );
}

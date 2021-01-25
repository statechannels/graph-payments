import {exec, ChildProcess} from 'child_process';
import waitOn from 'wait-on';
import kill from 'tree-kill';
import * as path from 'path';
import {PAYER_SERVER_URL, RECEIPT_SERVER_URL} from './constants';
import {Logger} from '@graphprotocol/common-ts';

class ExternalServer {
  private serverProcess: ChildProcess | undefined = undefined;
  public get pid() {
    return this.serverProcess?.pid;
  }
  public constructor(
    private command: string,

    private endpoint: string
  ) {}

  public async start(logger: Logger): Promise<void> {
    this.serverProcess = exec(this.command, {
      // todo: in theory, this should not be needed as the default value for env is process.env...
      env: process.env
    });

    this.serverProcess.on('error', (err) => {
      logger.error('server error', {err});
      throw err;
    });

    this.serverProcess.stderr?.on('data', (d) => {
      logger.error(d);
      throw new Error(d);
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
    `yarn ts-node ${script} listen ${opts?.join(' ')}`,

    PAYER_SERVER_URL
  );
}

export function createReceiptServer(opts: string[] = []): ExternalServer {
  return new ExternalServer(
    `yarn ts-node ${path.join(__dirname, 'receipt-server.ts')} listen ${opts.join(' ')}`,

    RECEIPT_SERVER_URL
  );
}

export function createFlameGraphPaymentServer(
  opts: string[] = ['--ensureAllocations false']
): ExternalServer {
  const script = path.join(__dirname, '../lib/src/payment-server.js');
  return new ExternalServer(
    `npx clinic flame -- node ${script} listen ${opts.join(' ')}`,
    PAYER_SERVER_URL
  );
}

export function createFlameGraphReceiptServer(opts: string[] = []): ExternalServer {
  const scriptPath = path.join(__dirname, '../lib/src/receipt-server.js');
  return new ExternalServer(
    `npx clinic flame  -- node ${scriptPath} listen ${opts.join(' ')}`,

    RECEIPT_SERVER_URL
  );
}

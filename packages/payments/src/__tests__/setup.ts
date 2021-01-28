/* eslint-disable @typescript-eslint/no-explicit-any */
import pino from 'pino';

import {DatabaseConnectionConfiguration} from '..';

const hooks = {
  logMethod(inputArgs: any[], method: any) {
    if (inputArgs.length >= 2) {
      const arg1 = inputArgs.shift();
      const arg2 = inputArgs.shift();
      return method.apply(this, [arg2, arg1, ...inputArgs]);
    }
    return method.apply(this, inputArgs);
  }
};

export const createTestLogger = (file?: string): any => {
  return file ? pino({hooks}, pino.destination(file)) : (pino({hooks}) as any);
};

export const PAYMENT_MANAGER_TEST_DB_NAME = 'payment_manager_test';
export const PAYMENT_MANAGER_TEST_DB_CONNECTION_STRING: DatabaseConnectionConfiguration = `postgresql://postgres@localhost:5432/${PAYMENT_MANAGER_TEST_DB_NAME}`;

export const CACHE_TEST_DB_NAME = 'cache_test';
export const CACHE_TEST_DB_CONNECTION_STRING: DatabaseConnectionConfiguration = `postgresql://postgres@localhost:5432/${CACHE_TEST_DB_NAME}`;

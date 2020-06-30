/* eslint-disable @typescript-eslint/no-explicit-any */
import pino from 'pino';
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

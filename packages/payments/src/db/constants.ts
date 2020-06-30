export const SCHEMA = 'payment_manager';
export const TABLE = `${SCHEMA}.payment_channels`;
export const CONNECTION_STRING = getEnvString('CONNECTION');

function getEnvString(key: string): string {
  const ENV_VAR_PREFIX = 'PAYMENT_MANAGER';
  const prefixedKey = `${ENV_VAR_PREFIX}_${key}`;

  const value = process.env[prefixedKey];

  if (typeof value !== 'string') throw Error(`Expected process.env.${prefixedKey} to be a string`);

  return value;
}

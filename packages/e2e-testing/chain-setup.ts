/* eslint-disable no-process-env */
import {ETHERLIME_ACCOUNTS, GanacheServer} from '@statechannels/devtools';
import {utils} from 'ethers';
import {deploy as deployNitro} from '@statechannels/server-wallet/lib/deployment/deploy';
import {deploy as deployGraph} from '@graphprotocol/statechannels-contracts/deployment/deploy';

export default async function setup(): Promise<void> {
  if (process.env.CHAIN_NETWORK_ID) {
    console.log(
      `CHAIN_NETWORK_ID defined as ${process.env.CHAIN_NETWORK_ID}. Assuming chain env vars are set by caller`
    );
    return;
  }

  process.env['CHAIN_NETWORK_ID'] = '9002';
  process.env['GANACHE_HOST'] = '0.0.0.0';
  process.env['GANACHE_PORT'] = '8545';
  process.env[
    'RPC_ENDPOINT'
  ] = `http://${process.env['GANACHE_HOST']}:${process.env['GANACHE_PORT']}`;
  const ethPerAccount = utils.parseEther('100').toString();
  const etherlimeAccounts = ETHERLIME_ACCOUNTS.map((account) => ({
    ...account,
    amount: ethPerAccount
  }));

  if (!process.env.GANACHE_PORT) {
    throw new Error('process.env.GANACHE_PORT must be defined');
  }
  const ganacheServer = new GanacheServer(
    parseInt(process.env.GANACHE_PORT),
    Number(process.env.CHAIN_NETWORK_ID),
    etherlimeAccounts,
    10_000, // timeout
    10_00_000_000, // gasLimit
    1 // gasPrice
  );
  await ganacheServer.ready();

  const deployedNitroArtifacts = await deployNitro();
  const deployedAttestationApp = await deployGraph();

  process.env = {...process.env, ...deployedNitroArtifacts, ...deployedAttestationApp};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__ARTIFACTS__ = {...deployedNitroArtifacts, ...deployedAttestationApp};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__GANACHE_SERVER__ = ganacheServer;
}

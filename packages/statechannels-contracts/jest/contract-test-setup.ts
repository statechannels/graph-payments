import {GanacheServer, configureEnvVariables} from '@statechannels/devtools';

import {deploy} from '../deployment/deploy';

export default async function setup(): Promise<void> {
  configureEnvVariables();

  const ganacheServer = new GanacheServer(
    Number(process.env.GANACHE_PORT),
    Number(process.env.CHAIN_NETWORK_ID)
  );

  await ganacheServer.ready();

  const deployedArtifacts = await deploy();

  process.env = {...process.env, ...deployedArtifacts};

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__GANACHE_SERVER__ = ganacheServer;
}

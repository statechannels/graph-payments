import {GanacheDeployer} from '@statechannels/devtools';

import attestationAppArtifact from '../artifacts/contracts/AttestationApp.sol/AttestationApp.json';

type TestNetworkContext = {
  ATTESTATION_APP: string;
};

const deploy = async (deployer?: GanacheDeployer): Promise<TestNetworkContext> => {
  deployer = deployer || new GanacheDeployer(Number(process.env.GANACHE_PORT));

  // eslint-disable-next-line
  const ATTESTATION_APP = await deployer.deploy(attestationAppArtifact as any);

  return {ATTESTATION_APP};
};

export {deploy};

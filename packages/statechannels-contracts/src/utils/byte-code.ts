import AttestationAppArtifact from '../../artifacts/contracts/AttestationApp.sol/AttestationApp.json';

export const getAttestionAppByteCode = (): string => AttestationAppArtifact.deployedBytecode;

import {Wallet} from 'ethers';

const SALT = '0xa070ffb1cd7409649bf77822cce74495468e06dbfaef09556838bf188679b9c2';

export async function signAttestation(
  privateKey: string,
  requestCID: string,
  responseCID: string,
  subgraphDeploymentID: string,
  chainId: number,
  verifyingContract: string
): Promise<string> {
  const domain = {
    name: 'Graph Protocol',
    version: '0',
    chainId,
    verifyingContract,
    salt: SALT
  };
  const types = {
    Receipt: [
      {name: 'requestCID', type: 'bytes32'},
      {name: 'responseCID', type: 'bytes32'},
      {name: 'subgraphDeploymentID', type: 'bytes32'}
    ]
  };
  const values = {requestCID, responseCID, subgraphDeploymentID};
  const signer = new Wallet(privateKey);

  return signer._signTypedData(domain, types, values);
}

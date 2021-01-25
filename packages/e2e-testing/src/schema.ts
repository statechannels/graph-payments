import {Address, SubgraphDeploymentID} from '@graphprotocol/common-ts';
import {Allocation, Indexer} from '@graphprotocol/payments/src/query-engine-types';
import joi from 'joi';

type JoiSubgraphDeploymentID = Pick<SubgraphDeploymentID, 'bytes32'>;
const subgraphDeploymentID = joi.object({bytes32: joi.string().required()});

type JoiIndexer = Pick<Indexer, 'id' | 'url'>;
const indexer = joi.object({
  url: joi.string().required(),
  id: joi.string().required()
});

export type JoiAllocation = {
  id: Address;
  subgraphDeploymentID: JoiSubgraphDeploymentID;
  indexer: JoiIndexer;
};

export const allocation = joi
  .object<JoiAllocation>({
    id: joi.string().required(),
    indexer: indexer.required(),
    subgraphDeploymentID: subgraphDeploymentID.required()
  })
  .required();

export function toJoiAllocation({
  id,
  indexer: {id: indexerId, url},
  subgraphDeploymentID: {bytes32}
}: Allocation): JoiAllocation {
  return {
    id,
    indexer: {id: indexerId, url},
    subgraphDeploymentID: {bytes32}
  };
}

/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as fs from 'fs';

import axios from 'axios';
import _ from 'lodash';

import {PAYER_SERVER_URL} from './constants';
import {SyncAllocationEvent, StoredTestData} from './load-generator';
import {JoiAllocation, toJoiAllocation} from './schema';
import {generateAllocations} from './utils';
/*
This script
- imports some previously generated events from events.json
- constructs a sequence of `syncAllocations` calls from the events
- sends the requests to the payment server at the scheduled time
*/

const {events, config}: StoredTestData = JSON.parse(fs.readFileSync('data/events.json').toString());

const INDEXER_URL = 'http://localhost:5198';
function allocationGenerator(num = 1): JoiAllocation[] {
  // The number required, as the sum of iid random variables, has variance on the order of its square root
  return generateAllocations(num)
    .map(toJoiAllocation)
    .map((a) => {
      a.indexer.url = INDEXER_URL;
      return a;
    });
}

function computeRequests(e: SyncAllocationEvent, allocations: JoiAllocation[]) {
  return e.active
    .map((idx) => allocations[idx])
    .map((allocation) => ({active: true, allocation, capacity: config.initialCapacity}))
    .map(({allocation, capacity}) => ({
      allocation,
      type: 'SetTo',
      num: capacity
    }));
}

const {avgNumToAdd, numEpochs} = config;

const expectedAllocations = avgNumToAdd * numEpochs;
const msg = `create allocation generator: ${expectedAllocations}`;
console.time(msg);
const allocations = allocationGenerator(_.last(events)!.numAdded + 1);
console.timeEnd(msg);

console.log('running sync allocations', {allocations: events.map((e) => e.active.length)});

const now = Date.now();
events.map((event: SyncAllocationEvent) =>
  setTimeout(async () => {
    const requests = computeRequests(event, allocations);

    console.log(Date.now() - now, requests.length, event.timestamp);

    const msg = `syncing ${requests.length} allocations at ${event.timestamp}`;
    console.time(msg);
    console.log(
      (
        await axios.post(
          `${PAYER_SERVER_URL}/syncAllocations`,
          {requests},
          {timeout: 10 * config.epochInterval}
        )
      ).data
    );
    console.timeEnd(msg);
  }, event.timestamp)
);

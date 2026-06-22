// Copyright (c) Wick Markets
// SPDX-License-Identifier: Apache-2.0
//
// findRidesOwnedBy enumerates one address's RidePosition objects (used by bots /
// whitelisted accounts to find rides to crank). Its correctness hinges on two
// things a stub client can verify without a network: it must page through ALL
// results (broken pagination silently misses a user's rides), and it must skip
// malformed entries with no object id. Pin both, plus the type filter.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { findRidesOwnedBy } from "../src/ride.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cfg = { packageId: "0xpkg" } as any;

test("findRidesOwnedBy pages through every result and extracts id + raw content", async () => {
  let calls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = {
    getOwnedObjects: async (args: any) => {
      calls++;
      assert.equal(args.filter.StructType, "0xpkg::ride_position::RidePosition");
      assert.equal(args.owner, "0xowner");
      if (calls === 1) {
        return {
          data: [{ data: { objectId: "0x1", content: { v: 1 } } }],
          hasNextPage: true,
          nextCursor: "c1",
        };
      }
      return {
        data: [{ data: { objectId: "0x2", content: { v: 2 } } }],
        hasNextPage: false,
        nextCursor: null,
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const rides = await findRidesOwnedBy(client, cfg, "0xowner");
  assert.equal(calls, 2, "paginated through both pages");
  assert.deepEqual(rides.map((r) => r.id), ["0x1", "0x2"]);
  assert.deepEqual(rides.map((r) => r.raw), [{ v: 1 }, { v: 2 }]);
});

test("findRidesOwnedBy skips malformed entries with no object id", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = {
    getOwnedObjects: async () => ({
      data: [
        { data: { objectId: "0x1", content: {} } },
        { data: {} }, // no objectId
        { other: "junk" }, // no data
      ],
      hasNextPage: false,
      nextCursor: null,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const rides = await findRidesOwnedBy(client, cfg, "0xowner");
  assert.deepEqual(rides.map((r) => r.id), ["0x1"]);
});

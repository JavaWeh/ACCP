import test from "node:test";
import assert from "node:assert/strict";
import { validateLimits } from "../check-capacity-resources.mjs";

test("capacity limits require both Docker configuration and effective controllers", () => {
  const host = { CpuQuota: 300000, CpuPeriod: 100000, Memory: 10 * 2 ** 30 };
  assert.equal(
    validateLimits(host, `300000 100000 ${10 * 2 ** 30}`, 3, 10).enforced,
    true,
  );
  assert.throws(() =>
    validateLimits(
      { ...host, CpuQuota: 0 },
      `300000 100000 ${10 * 2 ** 30}`,
      3,
      10,
    ),
  );
  assert.throws(() => validateLimits(host, `-1 100000 ${10 * 2 ** 30}`, 3, 10));
  assert.throws(() =>
    validateLimits(host, `max 100000 ${10 * 2 ** 30}`, 3, 10),
  );
  assert.throws(() => validateLimits(host, `300000 100000 max`, 3, 10));
  assert.throws(() =>
    validateLimits(host, `400000 100000 ${10 * 2 ** 30}`, 3, 10),
  );
  assert.throws(() =>
    validateLimits(
      { ...host, Memory: 0 },
      `300000 100000 ${10 * 2 ** 30}`,
      3,
      10,
    ),
  );
});

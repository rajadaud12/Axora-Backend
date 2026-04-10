declare const process: { exit: (code?: number) => void };

/**
 * Portfolio / share math checks for Dinari dShare balances.
 *
 * Run: npx ts-node scripts/test-portfolio-math.ts
 *
 * This does NOT call Dinari or Alchemy — it models the same formulas as
 * `GET /api/dinari/portfolio/:wallet` (balance merge + Number(raw)/1e18).
 */

import { formatUnits, parseUnits } from 'viem';

let failures = 0;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('OK:  ', msg);
  }
}

/** Mirrors axora-backend/src/routes/dinari.ts portfolio merge */
function mergedRawFromAlchemyRows(
  eoaRows: { contractAddress: string; tokenBalance: string }[],
  swRows: { contractAddress: string; tokenBalance: string }[],
): Map<string, bigint> {
  const balanceMap: Record<string, bigint> = {};
  for (const tb of [...eoaRows, ...swRows]) {
    const addr = tb.contractAddress.toLowerCase();
    const raw = BigInt(tb.tokenBalance || '0');
    balanceMap[addr] = (balanceMap[addr] || 0n) + raw;
  }
  return new Map(Object.entries(balanceMap).map(([k, v]) => [k, v]));
}

/** Current backend conversion (problematic for large integers) */
function sharesBackendStyle(raw: bigint): number {
  return Number(raw) / 1e18;
}

function sharesViemStyle(raw: bigint, decimals = 18): number {
  return Number(formatUnits(raw, decimals));
}

function main() {
  console.log('\n=== 1) Notional → expected shares (no prior position) ===\n');
  const spendUsd = 150;
  const px = 183.91;
  const expectedShares = spendUsd / px;
  console.log(`  $${spendUsd} at $${px}/share → ~${expectedShares.toFixed(6)} shares`);
  console.log(`  Dinari assets showed NVDA amount ≈ 1.499313`);
  assert(
    Math.abs(1.499313 - expectedShares) > 0.25,
    '1.499313 shares is NOT explained by $150 alone at ~$184 (expect ~0.82) — gap matches “had prior stock” OR “~2× fill/counting”',
  );
  assert(
    Math.abs(1.499313 - expectedShares * 2) < 0.25,
    '1.499313 is within ~0.25 of 2× the $150-only share count — consistent with duplicate fill or EOA+SCW double-count hypothesis',
  );

  console.log('\n=== 2) EOA + SCW merge doubles if BOTH report the same full balance ===\n');
  const token = '0x4b47153a241b9d22ae37c2aee7a6519ff2dbfc6';
  // If real balance were half of the reported 1.499313, duplicate EOA+SW reads → exactly 1.499313
  const trueShares = 1.499313 / 2;
  const trueRaw = parseUnits(String(trueShares), 18);
  // Bug: indexer returns the SCW balance for BOTH the EOA query and the SCW query
  const eoaBug = [{ contractAddress: token, tokenBalance: trueRaw.toString() }];
  const swBug = [{ contractAddress: token, tokenBalance: trueRaw.toString() }];
  const mergedBug = mergedRawFromAlchemyRows(eoaBug, swBug);
  const doubled = sharesBackendStyle(mergedBug.get(token.toLowerCase())!);
  console.log(`  True shares (simulated):     ${trueShares}`);
  console.log(`  Merged shares if 2× same raw: ${doubled.toFixed(7)} (≈ ${(doubled / trueShares).toFixed(2)}×)`);
  assert(
    Math.abs(doubled - trueShares * 2) < 1e-6,
    'Duplicate identical raw from EOA+SW paths should merge to ~2× true shares',
  );

  console.log('\n=== 3) Number(raw)/1e18 vs formatUnits (precision) ===\n');
  const raw1499313 = BigInt('1499313000000000000'); // ~1.499313 * 1e18
  const n = sharesBackendStyle(raw1499313);
  const v = sharesViemStyle(raw1499313, 18);
  console.log(`  raw = ${raw1499313}`);
  console.log(`  Number(raw)/1e18     = ${n}`);
  console.log(`  formatUnits(raw, 18) = ${v}`);
  assert(Math.abs(n - v) < 1e-9, 'For this magnitude, Number/1e18 matches formatUnits (may differ for other values > 2^53)');

  const huge = BigInt('10') ** BigInt('18') * BigInt('12345678'); // 12.345678e18
  const nH = Number(huge) / 1e18;
  const vH = Number(formatUnits(huge, 18));
  console.log(`\n  Larger raw example:`);
  console.log(`  Number(raw)/1e18     = ${nH}`);
  console.log(`  formatUnits(raw, 18) = ${vH}`);
  assert(
    nH === vH || Math.abs(nH - vH) < 1e-6,
    'Note: Number(bigint) above MAX_SAFE_INTEGER can drift — prefer formatUnits in production',
  );

  console.log('\n=== Summary ===\n');
  console.log(
    '  • Live Dinari "assets" (1.499313 NVDA) cannot be verified here without API keys.',
  );
  console.log(
    '  • If you had no prior NVDA, ~1.5 shares after ~$150 notional suggests ~2× logic somewhere',
  );
  console.log(
    '    (duplicate order, or portfolio merge seeing the same balance twice, etc.).',
  );
  console.log(
    '  • Fix direction: compare Dinari assets vs sum of ERC-20 balanceOf(SC W) only,',
  );
  console.log('    and guard omnibus confirm-buy idempotency.\n');

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.\n`);
    process.exit(1);
  }
  process.exit(0);
}

main();

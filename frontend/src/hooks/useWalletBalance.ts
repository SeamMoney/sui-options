import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const SUI_TYPE = "0x2::sui::SUI";

/**
 * Returns the connected wallet's SUI balance in mist (as a bigint), plus a
 * sorted list of individual SUI coin balances. Used by TradePanel to gate
 * the bet flow and explain "no valid gas coins" before opening the wallet.
 */
export function useWalletBalance() {
  const account = useCurrentAccount();
  const sui = useSuiClient() as unknown as SuiJsonRpcClient;
  return useQuery({
    queryKey: ["wallet", "balance", account?.address ?? "anon"],
    queryFn: async (): Promise<{
      total: bigint;
      coins: { coinObjectId: string; balance: bigint }[];
      largest: bigint;
    }> => {
      if (!account) return { total: 0n, coins: [], largest: 0n };
      const { data } = await sui.getCoins({
        owner: account.address,
        coinType: SUI_TYPE,
      });
      const coins = data.map((c) => ({
        coinObjectId: c.coinObjectId,
        balance: BigInt(c.balance),
      }));
      const total = coins.reduce((acc, c) => acc + c.balance, 0n);
      const largest = coins.reduce(
        (m, c) => (c.balance > m ? c.balance : m),
        0n,
      );
      return { total, coins, largest };
    },
    enabled: !!account,
    refetchInterval: 6_000,
    staleTime: 3_000,
  });
}

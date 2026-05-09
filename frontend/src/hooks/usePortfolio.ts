import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { WickClient, type Deployment } from "@wick/sdk";
import { PACKAGE_ID } from "@/lib/sui";
import deployment from "@/config/deployment.json";

export function usePortfolio() {
  const sui = useSuiClient() as unknown as SuiJsonRpcClient;
  const account = useCurrentAccount();
  const wick = useMemo(
    () => new WickClient({ sui, deployment: deployment as Deployment }),
    [sui],
  );
  return useQuery({
    queryKey: ["wick", "portfolio", PACKAGE_ID, account?.address ?? "anon"],
    queryFn: async () => {
      if (!account) return { positions: [], lpPositions: [] };
      const [positions, lpPositions] = await Promise.all([
        wick.listPositions(account.address),
        wick.listLpPositions(account.address),
      ]);
      return { positions, lpPositions };
    },
    enabled: !!account,
    refetchInterval: 8_000,
    staleTime: 4_000,
  });
}

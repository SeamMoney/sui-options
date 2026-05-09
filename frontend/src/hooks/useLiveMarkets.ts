import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSuiClient } from "@mysten/dapp-kit";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { WickClient, type Deployment } from "@wick/sdk";
import { COLLATERAL_TYPE, PACKAGE_ID } from "@/lib/sui";
import deployment from "@/config/deployment.json";

export function useLiveMarkets() {
  const sui = useSuiClient() as unknown as SuiJsonRpcClient;
  const wick = useMemo(
    () => new WickClient({ sui, deployment: deployment as Deployment }),
    [sui],
  );
  return useQuery({
    queryKey: ["wick", "markets", PACKAGE_ID],
    queryFn: () => wick.listMarkets({ collateralType: COLLATERAL_TYPE }),
    refetchInterval: 8_000,
    refetchOnWindowFocus: true,
    staleTime: 4_000,
  });
}

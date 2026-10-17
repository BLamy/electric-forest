import { createContext, useContext, type ReactNode } from "react";
import type { RegistryState } from "@eforest/reducers";
import type { StreamReducerResult } from "@eforest/web-hooks";

interface RegistryContextValue {
  readonly projection: StreamReducerResult<RegistryState>;
  readonly refresh: () => void;
}

const RegistryContext = createContext<RegistryContextValue | null>(null);

export function RegistryProvider(props: {
  readonly value: StreamReducerResult<RegistryState>;
  readonly children: ReactNode;
  readonly onRefresh: () => void;
}): React.JSX.Element {
  return (
    <RegistryContext.Provider value={{ projection: props.value, refresh: props.onRefresh }}>
      {props.children}
    </RegistryContext.Provider>
  );
}

export function useRegistryProjection(): StreamReducerResult<RegistryState> {
  const value = useContext(RegistryContext);
  if (value === null) throw new Error("useRegistryProjection must be used inside RegistryProvider");
  return value.projection;
}

export function useRefreshRegistry(): () => void {
  const value = useContext(RegistryContext);
  if (value === null) throw new Error("useRefreshRegistry must be used inside RegistryProvider");
  return value.refresh;
}

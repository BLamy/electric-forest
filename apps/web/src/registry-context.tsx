import { createContext, useContext, type ReactNode } from "react";
import type { RegistryState } from "@eforest/reducers";
import type { StreamReducerResult } from "@eforest/web-hooks";

const RegistryContext = createContext<StreamReducerResult<RegistryState> | null>(null);

export function RegistryProvider(props: {
  readonly value: StreamReducerResult<RegistryState>;
  readonly children: ReactNode;
}): React.JSX.Element {
  return <RegistryContext.Provider value={props.value}>{props.children}</RegistryContext.Provider>;
}

export function useRegistryProjection(): StreamReducerResult<RegistryState> {
  const value = useContext(RegistryContext);
  if (value === null) throw new Error("useRegistryProjection must be used inside RegistryProvider");
  return value;
}

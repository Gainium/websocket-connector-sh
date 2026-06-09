import UserConnector from './userStream'

/**
 * Indirection so a downstream build can swap in a `UserConnector`
 * subclass without forking core. `index.ts` instantiates
 * `getConnectorClass()` rather than `UserConnector` directly; a wrapper
 * registers its subclass via `setConnectorClass()` before `index.ts`
 * runs. Defaults to the stock `UserConnector`, so the public build is
 * unaffected.
 */
let ConnectorClass: typeof UserConnector = UserConnector

export function getConnectorClass(): typeof UserConnector {
  return ConnectorClass
}

export function setConnectorClass(cls: typeof UserConnector): void {
  ConnectorClass = cls
}

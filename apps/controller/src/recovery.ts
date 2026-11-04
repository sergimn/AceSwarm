export type RecoveryAction = "restart-pipeline" | "restart-engine" | "switch-path";

export interface RecoveryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RecoveryState {
  /** Failed attempts since the stream was last healthy. */
  failures: number;
  /** When the previous recovery action ran. */
  lastActionAt: number | undefined;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  /** Earliest time the action may run (exponential backoff). */
  notBefore: number;
}

/**
 * The recovery ladder. Cheap, local fixes come first; the network path only changes after
 * restarting the pipeline and the engine did not help, because a path switch is the most visible
 * change for viewers.
 *
 * failures: 0 → restart pipeline, 1 → restart pipeline, 2 → restart engine, 3 → switch path,
 * then alternate engine restart and path switch with growing delays.
 */
export function nextRecovery(state: RecoveryState, policy: RecoveryPolicy, canSwitchPath: boolean): RecoveryDecision {
  const { failures } = state;
  let action: RecoveryAction;
  if (failures < 2) {
    action = "restart-pipeline";
  } else if (failures === 2) {
    action = "restart-engine";
  } else if (canSwitchPath && failures % 2 === 1) {
    action = "switch-path";
  } else {
    action = "restart-engine";
  }
  const delay = failures === 0 ? 0 : Math.min(policy.baseDelayMs * 2 ** (failures - 1), policy.maxDelayMs);
  return { action, notBefore: (state.lastActionAt ?? 0) + delay };
}
